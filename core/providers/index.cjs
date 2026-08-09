'use strict'

const googleHealth = require('./google-health.cjs')
const fitbitLegacy = require('./fitbit-legacy.cjs')

const DEFAULT_PROVIDER = 'google-health'

const PROVIDERS = {
  'google-health': googleHealth,
  'fitbit-legacy': fitbitLegacy,
}

function isProvider(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id)
}

function providerId(config) {
  return isProvider(config?.provider) ? config.provider : DEFAULT_PROVIDER
}

function providerFor(credentials) {
  const id = providerId(credentials?.config)
  const service = PROVIDERS[id]
  if (!service) throw new Error(`Unsupported health provider: ${id}`)
  return service
}

module.exports = { PROVIDERS, DEFAULT_PROVIDER, isProvider, providerId, providerFor }
