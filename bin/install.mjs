#!/usr/bin/env node
/**
 * @file Passive auto-installer for Kestrel (dsh-deep-research).
 * Links the plugin into DSH Web/Dev profiles and registers it inside the
 * Superpowers agent preset so it runs automatically without manual approval prompts.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

export function installToDsh() {
  console.log('=== Installing Kestrel (dsh-deep-research) into DeepSeek Harness ===')
  console.log(`Repo: ${REPO_ROOT}`)
  console.log(`DSH Home: ${DSH_HOME}\n`)

  let installedCount = 0

  // 1. Install into Web profile
  const webPkgPath = join(DSH_HOME, 'profiles', 'web', 'package.json')
  if (existsSync(webPkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(webPkgPath, 'utf8'))
      pkg.dependencies = pkg.dependencies || {}
      pkg.dsh = pkg.dsh || {}
      pkg.dsh.profile = pkg.dsh.profile || {}
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []

      pkg.dependencies['dsh-deep-research'] = `link:${REPO_ROOT.replace(/\\/g, '/')}`
      if (!pkg.dsh.profile.bundles.includes('dsh-deep-research')) {
        pkg.dsh.profile.bundles.push('dsh-deep-research')
      }

      writeFileSync(webPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
      console.log(`✔ Registered in DSH Web profile: ${webPkgPath}`)
      installedCount++
    } catch (err) {
      console.warn(`! Failed to update Web profile: ${err.message}`)
    }
  }

  // 2. Install into Dev profile
  const devPkgPath = join(DSH_HOME, 'profiles', 'dev', 'package.json')
  if (existsSync(devPkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(devPkgPath, 'utf8'))
      pkg.dependencies = pkg.dependencies || {}
      pkg.dsh = pkg.dsh || {}
      pkg.dsh.profile = pkg.dsh.profile || {}
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []

      pkg.dependencies['dsh-deep-research'] = `link:${REPO_ROOT.replace(/\\/g, '/')}`
      if (!pkg.dsh.profile.bundles.includes('dsh-deep-research')) {
        pkg.dsh.profile.bundles.push('dsh-deep-research')
      }

      writeFileSync(devPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
      console.log(`✔ Registered in DSH Dev profile: ${devPkgPath}`)
      installedCount++
    } catch (err) {
      console.warn(`! Failed to update Dev profile: ${err.message}`)
    }
  }

  // 3. Wire into Superpowers preset in ~/.dsh/.agent-presets/superpowers/agent.cordis.yml
  const superpowersAgentYml = join(DSH_HOME, '.agent-presets', 'superpowers', 'agent.cordis.yml')
  if (existsSync(superpowersAgentYml)) {
    try {
      let content = readFileSync(superpowersAgentYml, 'utf8')
      if (!content.includes('dsh-deep-research')) {
        const row = `\n# ── Kestrel Deep Research & Fact Verification ─────────────────────────────\n- id: kestrel-research\n  name: dsh-deep-research\n`
        content += row
        writeFileSync(superpowersAgentYml, content, 'utf8')
        console.log(`✔ Wired into Superpowers preset: ${superpowersAgentYml}`)
        installedCount++
      } else {
        console.log(`✔ Superpowers preset already includes dsh-deep-research`)
      }
    } catch (err) {
      console.warn(`! Failed to update Superpowers preset: ${err.message}`)
    }
  }

  console.log(`\nInstallation complete. (${installedCount} configurations updated)`)
  console.log(`Kestrel is now automatically and passively active on profile boot.`)
}

if (process.argv[1]?.endsWith('install.mjs')) {
  installToDsh()
}
