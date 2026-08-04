#!/usr/bin/env node
// 模板驱动构建：解析 templates/egern-lazy.yaml，派生三端懒人配置
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

type Obj = Record<string, any>

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')
const TEMPLATE_PATH = join(ROOT, 'templates', 'egern-lazy.yaml')

const now = new Date().toISOString().slice(0, 19)
const LATENCY_URL = 'https://www.gstatic.com/generate_204'

interface Group {
  kind: string
  name: string
  type?: string
  policies?: string[]
  filter?: string
  urls?: string[]
  url?: string
  interval?: number
  tolerance?: number
}

interface FlatRule {
  kind: string
  match?: string
  policy?: string
  no_resolve?: boolean
}

function getTemplate(): Obj {
  const config = parse(readFileSync(TEMPLATE_PATH, 'utf8')) as Obj | null
  if (!config) throw new Error(`无法解析模板: ${TEMPLATE_PATH}`)
  return config
}

// ── 策略组 ──────────────────────────────────────────────────────
function getGroups(config: Obj): Group[] {
  const raw = (config.policy_groups ?? []) as Obj[]
  return raw.map((g) => {
    const kind = Object.keys(g)[0]
    return { kind, ...(g[kind] as Obj) } as Group
  })
}

// ── 规则：展开 or，丢弃无法表达的 and/not/protocol ─────────────
function flattenRules(config: Obj): FlatRule[] {
  const raw = (config.rules ?? []) as Obj[]
  const out: FlatRule[] = []
  for (const r of raw) {
    const kind = Object.keys(r)[0]
    const def = r[kind] as Obj
    if (kind === 'or') {
      for (const sub of (def.match ?? []) as Obj[]) {
        const sk = Object.keys(sub)[0]
        const sdef = sub[sk] as Obj
        out.push({ kind: sk, match: sdef.match, policy: def.policy, no_resolve: sdef.no_resolve })
      }
    } else if (kind === 'and' || kind === 'not' || kind === 'protocol') {
      console.warn(`[skip] 规则无法转换到 Clash/Shadowrocket: ${kind}`)
    } else {
      out.push({ kind, match: def.match, policy: def.policy, no_resolve: def.no_resolve })
    }
  }
  return out
}

// ── 工具 ────────────────────────────────────────────────────────
const q = (v: string): string =>
  /^[A-Za-z][A-Za-z0-9._-]*$/.test(v) ? v : JSON.stringify(v)

function slug(name: string): string {
  return name
    .replace(/\s+/g, '-')
    .replace(/[^\w.-]/g, '')
    .toLowerCase()
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base || 'rule'
  let i = 2
  while (used.has(name)) name = `${base}-${i++}`
  used.add(name)
  return name
}

function ruleSetName(url: string): string {
  const last = url.split('/').pop() ?? 'rule'
  return last.replace(/\.(yaml|yml|list)$/i, '').replace(/[^A-Za-z0-9_-]/g, '_')
}

// ── Clash ───────────────────────────────────────────────────────
function genClash(config: Obj): string {
  const groups = getGroups(config)
  const rules = flattenRules(config)
  const external = groups.filter((g) => g.kind === 'external')
  const externalNames = new Set(external.map((g) => g.name))

  const ipv6 = config.ipv6 === true

  const providers = external
    .map((g, i) => {
      const p = `airport-${i + 1}`
      return (
        `  ${g.name}:\n` +
        `    type: http\n` +
        `    url: "${g.urls?.[0] ?? 'https://your-subscribe-url/sub'}"\n` +
        `    interval: 86400\n` +
        `    path: ./providers/${p}.yaml\n` +
        `    health-check:\n` +
        `      enable: true\n` +
        `      url: ${LATENCY_URL}\n` +
        `      interval: 300`
      )
    })
    .join('\n')

  const proxyGroups = groups
    .filter((g) => g.kind !== 'external')
    .map((g) => {
      const use = (g.policies ?? []).filter((p) => externalNames.has(p))
      const proxies = (g.policies ?? []).filter((p) => !externalNames.has(p))
      const isTest = g.kind === 'smart' || g.kind === 'auto_test'
      const lines = [`  - name: ${q(g.name)}`]
      lines.push(isTest ? '    type: url-test' : '    type: select')
      if (isTest) {
        lines.push(`    url: ${g.url ?? LATENCY_URL}`)
        lines.push(`    interval: ${g.interval ?? 300}`)
        if (g.tolerance != null) lines.push(`    tolerance: ${g.tolerance}`)
      }
      if (use.length) lines.push(`    use: [${use.map(q).join(', ')}]`)
      if (proxies.length) lines.push(`    proxies: [${proxies.map(q).join(', ')}]`)
      if (g.filter && use.length) lines.push(`    filter: "${g.filter.replace(/"/g, '\\"')}"`)
      return lines.join('\n')
    })
    .join('\n')

  // rule-providers：为 rule_set 规则生成，按 URL 去重
  const usedNames = new Set<string>()
  const providerName = new Map<string, string>()
  const providersBlock: string[] = []
  for (const r of rules) {
    if (r.kind !== 'rule_set' || !r.match || providerName.has(r.match)) continue
    const name = uniqueName(ruleSetName(r.match), usedNames)
    providerName.set(r.match, name)
    const format = /\.(yaml|yml)$/i.test(r.match) ? 'yaml' : /\.list$/i.test(r.match) ? 'text' : ''
    providersBlock.push(
      `  ${name}:\n` +
        `    type: http\n` +
        `    behavior: classical\n` +
        (format ? `    format: ${format}\n` : '') +
        `    url: ${r.match}\n` +
        `    path: ./rules/${name}.yaml\n` +
        `    interval: 86400`
    )
  }

  const ruleLines: string[] = []
  let finalPolicy = 'PROXY'
  for (const r of rules) {
    let line: string | null = null
    switch (r.kind) {
      case 'rule_set': {
        const n = r.match ? providerName.get(r.match) : undefined
        if (n) line = `  - RULE-SET,${n},${r.policy}`
        break
      }
      case 'domain': line = `  - DOMAIN,${r.match},${r.policy}`; break
      case 'domain_suffix': line = `  - DOMAIN-SUFFIX,${r.match},${r.policy}`; break
      case 'domain_keyword': line = `  - DOMAIN-KEYWORD,${r.match},${r.policy}`; break
      case 'domain_wildcard': line = `  - DOMAIN-WILDCARD,${r.match},${r.policy}`; break
      case 'ip_cidr': line = `  - IP-CIDR,${r.match},${r.policy}${r.no_resolve ? ',no-resolve' : ''}`; break
      case 'geoip': line = `  - GEOIP,${r.match},${r.policy}${r.no_resolve ? ',no-resolve' : ''}`; break
      case 'user_agent': line = `  - USER-AGENT,${r.match},${r.policy}`; break
      case 'url_regex': line = `  - URL-REGEX,${r.match},${r.policy}`; break
      case 'default': finalPolicy = r.policy ?? finalPolicy; break
      default: console.warn(`[clash skip] 规则类型: ${r.kind}`)
    }
    if (line) ruleLines.push(line)
  }
  ruleLines.push(`  - MATCH,${finalPolicy}`)

  return `# ════════════════════════════════════════════════════════════════
#  Teakowa Rules · Clash 懒人配置（自动生成，请勿手动修改）
#  由 templates/egern-lazy.yaml 模板派生，更新模板后自动重建
# ════════════════════════════════════════════════════════════════

mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: ${ipv6}

dns:
  enable: true
  ipv6: ${ipv6}
  nameserver:
    - https://dns.alidns.com/dns-query
    - https://doh.pub/dns-query
  fallback:
    - https://8.8.8.8/dns-query
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29

# ── 订阅（替换 url 为你的机场链接）─────────────────────────────
proxy-providers:
${providers}

# ── 代理组 ──────────────────────────────────────────────────────
proxy-groups:
${proxyGroups}

# ── 规则集（自动更新，无需修改）─────────────────────────────────
rule-providers:
${providersBlock.join('\n')}

rules:
${ruleLines.join('\n')}
`
}

// ── Shadowrocket ────────────────────────────────────────────────
function genShadowrocket(config: Obj): string {
  const groups = getGroups(config)
  const rules = flattenRules(config)
  const external = groups.filter((g) => g.kind === 'external')
  const externalNames = new Set(external.map((g) => g.name))

  const proxies = external
    .map((g) => `${g.name} = sub, ${g.urls?.[0] ?? 'https://your-subscribe-url/sub'}, interval=86400`)
    .join('\n')

  const proxyGroups = groups
    .filter((g) => g.kind !== 'external')
    .map((g) => {
      const policies = (g.policies ?? []).join(', ')
      const filter = g.filter ? `, regex=${g.filter}` : ''
      if (g.kind === 'smart' || g.kind === 'auto_test') {
        return (
          `${g.name} = url-test, ${policies}` +
          `, url=${g.url ?? LATENCY_URL}` +
          `, interval=${g.interval ?? 300}` +
          (g.tolerance != null ? `, tolerance=${g.tolerance}` : '') +
          filter
        )
      }
      return `${g.name} = select, ${policies}${filter}`
    })
    .join('\n')

  const ruleLines: string[] = []
  let finalPolicy = 'PROXY'
  for (const r of rules) {
    let line: string | null = null
    switch (r.kind) {
      case 'rule_set': line = `RULE-SET,${r.match},${r.policy}`; break
      case 'domain': line = `DOMAIN,${r.match},${r.policy}`; break
      case 'domain_suffix': line = `DOMAIN-SUFFIX,${r.match},${r.policy}`; break
      case 'domain_keyword': line = `DOMAIN-KEYWORD,${r.match},${r.policy}`; break
      case 'domain_wildcard': line = `DOMAIN-WILDCARD,${r.match},${r.policy}`; break
      case 'ip_cidr': line = `IP-CIDR,${r.match},${r.policy}${r.no_resolve ? ',no-resolve' : ''}`; break
      case 'geoip': line = `GEOIP,${r.match},${r.policy}${r.no_resolve ? ',no-resolve' : ''}`; break
      case 'user_agent': line = `USER-AGENT,${r.match},${r.policy}`; break
      case 'url_regex': line = `URL-REGEX,${r.match},${r.policy}`; break
      case 'default': finalPolicy = r.policy ?? finalPolicy; break
      default: console.warn(`[shadowrocket skip] 规则类型: ${r.kind}`)
    }
    if (line) ruleLines.push(line)
  }
  ruleLines.push(`FINAL,${finalPolicy}`)

  return `# ════════════════════════════════════════════════════════════════
#  Teakowa Rules · Shadowrocket 懒人配置（自动生成，请勿手动修改）
#  由 templates/egern-lazy.yaml 模板派生，更新模板后自动重建
# ════════════════════════════════════════════════════════════════

[General]
loglevel = notify
dns-server = 8.8.8.8, 223.5.5.5
ipv6 = ${config.ipv6 === true}

[Proxy]
# 订阅（已内置，修改 url 或重新订阅）
${proxies}

[Proxy Group]
${proxyGroups}

[Rule]
${ruleLines.join('\n')}
`
}

// ── 主流程 ──────────────────────────────────────────────────────
function main(): void {
  const config = getTemplate()

  for (const dir of ['clash', 'egern', 'shadowrocket']) {
    mkdirSync(join(DIST, dir), { recursive: true })
  }

  writeFileSync(join(DIST, 'egern', 'lazy.yaml'), readFileSync(TEMPLATE_PATH, 'utf8'))
  writeFileSync(join(DIST, 'clash', 'lazy.yaml'), genClash(config))
  writeFileSync(join(DIST, 'shadowrocket', 'lazy.conf'), genShadowrocket(config))

  console.log('[ok] clash/lazy.yaml, egern/lazy.yaml, shadowrocket/lazy.conf')
}

main()
