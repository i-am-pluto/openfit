import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { profile as profileApi } from '@/lib/api'
import { EMPTY_USER_PROFILE, UNLOCKS, profileCompleteness } from '@/lib/user-profile'
import { InfoIcon, UserIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import type { UserProfile } from '@/types'

/**
 * The seven facts the provider cannot supply, captured inside the settings
 * dialog rather than behind a wizard.
 *
 * Every field is optional, so each one has to earn its keystrokes: the label
 * says what filling it in unlocks, and that sentence comes from `UNLOCKS` in
 * `src/lib/user-profile.ts` — the same list the completeness check reads — so
 * the promise here and the feature that honors it cannot drift apart.
 */

type ProfileField = Exclude<keyof UserProfile, 'userEdited'>

/**
 * `min`/`max` mirror `FIELD_RANGES` in `core/user-profile.cjs`. The store is
 * still the authority: it sanitizes anything outside the range to null. Mirroring
 * the bounds here means the user is told before that happens instead of watching
 * a typed value vanish.
 */
const FIELDS: Array<{
  field: ProfileField
  label: string
  unit: string
  min: number
  max: number
  step: number
  placeholder: string
}> = [
  { field: 'birthYear', label: 'Year of birth', unit: '', min: 1900, max: 2100, step: 1, placeholder: '1990' },
  { field: 'heightCm', label: 'Height', unit: 'cm', min: 50, max: 260, step: 1, placeholder: '175' },
  { field: 'measuredMaxHeartRate', label: 'Measured max heart rate', unit: 'bpm', min: 80, max: 260, step: 1, placeholder: '186' },
  { field: 'stepsGoal', label: 'Daily step goal', unit: 'steps', min: 100, max: 200000, step: 100, placeholder: '10000' },
  { field: 'sleepGoalMinutes', label: 'Nightly sleep goal', unit: 'minutes', min: 60, max: 900, step: 15, placeholder: '480' },
  { field: 'waterGoalMl', label: 'Daily water goal', unit: 'ml', min: 100, max: 20000, step: 100, placeholder: '2500' },
  { field: 'weightGoalKg', label: 'Weight target', unit: 'kg', min: 20, max: 400, step: 0.1, placeholder: '72.5' },
]

const UNLOCK_TEXT = new Map(UNLOCKS.map(({ field, unlocks }) => [field, unlocks]))

/**
 * "Heart-rate zones and VO2 max context" reads as a sentence after "Enables";
 * "BMI and its trend" does not survive being lowercased. Only demote a leading
 * capital when the second character is not itself a capital, which leaves
 * acronyms alone.
 */
function unlockSentence(field: ProfileField): string {
  const text = UNLOCK_TEXT.get(field) ?? ''
  if (!text) return ''
  const isAcronym = text[1] !== undefined && text[1] === text[1].toUpperCase() && text[1] !== text[1].toLowerCase()
  const body = isAcronym ? text : text[0].toLowerCase() + text.slice(1)
  return `Enables ${body}`
}

type Draft = Record<ProfileField, string>

function toDraft(profile: UserProfile): Draft {
  const draft = {} as Draft
  for (const { field } of FIELDS) {
    const value = profile[field]
    draft[field] = value === null || value === undefined ? '' : String(value)
  }
  return draft
}

/**
 * Where a value came from. A field the store holds but has not recorded in
 * `userEdited` was prefilled by the provider; anything in `userEdited` was typed
 * here and the store will never let a later sync overwrite it.
 *
 * An empty field is attributed to nobody. Clearing a value still marks it edited
 * server-side, but "Entered by you" beside a blank box says nothing useful.
 */
function originOf(profile: UserProfile, field: ProfileField): 'provider' | 'user' | null {
  const value = profile[field]
  if (value === null || value === undefined) return null
  return profile.userEdited.includes(field) ? 'user' : 'provider'
}

const ORIGIN_LABEL: Record<'provider' | 'user', string> = {
  provider: 'From your provider',
  user: 'Entered by you',
}

/**
 * `onChange` reports what the store actually holds after a load or a save, so
 * the panels a profile field unlocks appear without a reload. It is the stored
 * profile that travels, never the draft: a value the store rejected must not
 * light up a chart.
 */
export function ProfileSettings({ onChange }: { onChange?: (profile: UserProfile) => void } = {}) {
  const uid = useId()
  const [stored, setStored] = useState<UserProfile>(EMPTY_USER_PROFILE)
  const [draft, setDraft] = useState<Draft>(() => toDraft(EMPTY_USER_PROFILE))
  const [loading, setLoading] = useState(true)
  const [reachable, setReachable] = useState(true)
  const [savingField, setSavingField] = useState<ProfileField | null>(null)
  const [failure, setFailure] = useState<{ field: ProfileField; message: string } | null>(null)
  // Held in a ref so a caller passing an inline callback cannot re-run the load.
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  useEffect(() => {
    let cancelled = false
    profileApi
      .get()
      .then((next) => {
        if (cancelled) return
        setStored(next)
        setDraft(toDraft(next))
        setReachable(true)
        onChangeRef.current?.(next)
      })
      .catch(() => {
        // The demo path has no server behind it. Fall back to the all-null
        // profile and disable the form rather than blanking the dialog.
        if (cancelled) return
        setStored(EMPTY_USER_PROFILE)
        setDraft(toDraft(EMPTY_USER_PROFILE))
        setReachable(false)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const commit = useCallback(
    async (spec: (typeof FIELDS)[number]) => {
      const { field, min, max, label, unit } = spec
      const raw = draft[field].trim()
      const current = stored[field] ?? null
      const next = raw === '' ? null : Number(raw)

      if (next !== null && !Number.isFinite(next)) {
        setFailure({ field, message: `${label} must be a number.` })
        return
      }
      if (next !== null && (next < min || next > max)) {
        // The store would sanitize this to null. Say so instead of dropping it.
        setFailure({ field, message: `${label} must be between ${min} and ${max}${unit ? ` ${unit}` : ''}.` })
        return
      }
      if (next === current) {
        setFailure((previous) => (previous?.field === field ? null : previous))
        return
      }

      setSavingField(field)
      try {
        const saved = await profileApi.save({ [field]: next } as Partial<UserProfile>)
        setStored(saved)
        onChangeRef.current?.(saved)
        // Show what the store actually kept, not what was typed at it.
        setDraft(toDraft(saved))
        setFailure((previous) => (previous?.field === field ? null : previous))
      } catch (error) {
        // An unavailable secret store fails the write outright. Keep the typed
        // value on screen and say it is unsaved.
        setFailure({
          field,
          message: error instanceof Error ? error.message : 'That change could not be saved.',
        })
      } finally {
        setSavingField(null)
      }
    },
    [draft, stored],
  )

  const missing = useMemo(() => profileCompleteness(stored).missing.length, [stored])
  const filled = FIELDS.length - missing
  const disabled = loading || !reachable

  return (
    <section className="profile-settings" aria-labelledby={`${uid}-heading`}>
      <div className="profile-settings-header">
        <UserIcon />
        <div>
          <h3 id={`${uid}-heading`}>Profile</h3>
          <p>
            Google Health sends only your age. Height and every goal below can come from nowhere but
            here, and each one switches on something the dashboard cannot show without it. All optional,
            saved as you leave each field, and encrypted alongside your health data.
          </p>
        </div>
      </div>

      {!reachable && !loading && (
        <div className="scope-note" role="note">
          <InfoIcon />
          <p>
            This preview is not talking to an OpenFit server, so the profile cannot be loaded or saved.
            Run the server and reopen Settings to fill it in.
          </p>
        </div>
      )}

      <div className="profile-fields">
        {FIELDS.map((spec) => {
          const { field, label, unit, min, max, step, placeholder } = spec
          const inputId = `${uid}-${field}`
          const hintId = `${inputId}-hint`
          const errorId = `${inputId}-error`
          const origin = originOf(stored, field)
          const fieldFailure = failure?.field === field ? failure.message : null

          return (
            <div className="profile-field" key={field}>
              <div className="profile-field-head">
                <Label htmlFor={inputId}>
                  {label}
                  {unit && <span className="profile-field-unit">{unit}</span>}
                </Label>
                {origin && (
                  <span className={cn('profile-field-origin', origin === 'user' && 'is-user')}>
                    {ORIGIN_LABEL[origin]}
                  </span>
                )}
                {savingField === field && <LoaderCircle className="spin profile-field-saving" aria-label="Saving" />}
              </div>
              <Input
                id={inputId}
                type="number"
                inputMode="decimal"
                min={min}
                max={max}
                step={step}
                placeholder={placeholder}
                value={draft[field]}
                disabled={disabled || savingField === field}
                aria-describedby={fieldFailure ? `${hintId} ${errorId}` : hintId}
                aria-invalid={fieldFailure ? true : undefined}
                onChange={(event) => {
                  const value = event.target.value
                  setDraft((previous) => ({ ...previous, [field]: value }))
                }}
                // Saving on blur, not per keystroke: a half-typed "19" is not a
                // birth year, and every save is an encrypted write.
                onBlur={() => void commit(spec)}
              />
              <small id={hintId}>{unlockSentence(field)}</small>
              {fieldFailure && (
                <p className="profile-field-error" id={errorId} role="alert">
                  Not saved — {fieldFailure}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {!loading && reachable && (
        <p className="profile-completeness">
          {filled} of {FIELDS.length} filled.{' '}
          {missing === 0
            ? 'Everything the analysis can use is set.'
            : `${missing} ${missing === 1 ? 'feature is' : 'features are'} still switched off.`}
        </p>
      )}
    </section>
  )
}
