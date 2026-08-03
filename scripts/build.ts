#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

interface RuleSet {
  file: string
  name: string
  egernName: string
  policy: 'REJECT' | 'PROXY' | 'DIRECT'
}

interface EgernGroups {
  domain_set: string[]
  domain_suffix_set: string[]
  domain_keyword_set: string[]
  domain_wildcard_set: string[]
  ip_cidr_set: string[]
  ip_cidr6_set: string[]
  geoip_set: string[]
  asn_set: string[]
  url_regex_set: string[]
  user_agent_set: string[]
  dest_port_set: string[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')

// 可被环境变量覆盖，默认指向本仓库的 GitHub Pages 地址
const BASE_URL = (process.env.RULES_BASE_URL || 'https://teakowa.github.io/Rules').replace(/\/+$/, '')

// 源规则文件 → 规则集定义
const RULE_SETS: RuleSet[] = [
  { file: 'block.list', name: 'block', egernName: 'Block', policy: 'REJECT' },
  { file: 'Reject.list', name: 'reject', egernName: 'Reject', policy: 'REJECT' },
  { file: 'proxy.list', name: 'proxy', egernName: 'Proxy', policy: 'PROXY' },
  { file: 'Direct.list', name: 'direct', egernName: 'Direct', policy: 'DIRECT' },
  { file: 'UltraMobile.list', name: 'ultramobile', egernName: 'UltraMobile', policy: 'DIRECT' },
]

const now = new Date().toISOString().slice(0, 19)

// ── 解析 .list 源文件：去注释、去空白、去重、排序 ──────────────
function parseRules(file: string): string[] {
  const content = readFileSync(join(ROOT, file), 'utf8')
  const seen = new Set<string>()
  const rules: string[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const norm = line.replace(/\s+/g, '')
    if (!seen.has(norm)) {
      seen.add(norm)
      rules.push(norm)
    }
  }
  return rules.sort()
}

// ── Clash rule-provider（behavior: classical）─────────────────────
function genClash(name: string, rules: string[], policy: string): string {
  const lines = [
    '# Clash rule-provider (behavior: classical)',
    `# Source: ${name}.list`,
    `# Policy: ${policy}`,
    `# Generated: ${now}`,
    'payload:',
    ...rules.map((r) => `  - ${r}`),
    '',
  ]
  return lines.join('\n')
}

// ── Egern rule set（类型化分组）──────────────────────────────────
function genEgern(name: string, rules: string[], policy: string): string {
  const groups: EgernGroups = {
    domain_set: [],
    domain_suffix_set: [],
    domain_keyword_set: [],
    domain_wildcard_set: [],
    ip_cidr_set: [],
    ip_cidr6_set: [],
    geoip_set: [],
    asn_set: [],
    url_regex_set: [],
    user_agent_set: [],
    dest_port_set: [],
  }
  let noResolve = false
  for (const rule of rules) {
    const idx = rule.indexOf(',')
    const type = rule.slice(0, idx).trim().toUpperCase()
    const value = rule.slice(idx + 1).trim()
    switch (type) {
      case 'DOMAIN': groups.domain_set.push(value); break
      case 'DOMAIN-SUFFIX': groups.domain_suffix_set.push(value); break
      case 'DOMAIN-KEYWORD': groups.domain_keyword_set.push(value); break
      case 'DOMAIN-WILDCARD': groups.domain_wildcard_set.push(value); break
      case 'IP-CIDR': groups.ip_cidr_set.push(value.split(',')[0].trim()); if (value.includes('no-resolve')) noResolve = true; break
      case 'IP-CIDR6': groups.ip_cidr6_set.push(value.split(',')[0].trim()); if (value.includes('no-resolve')) noResolve = true; break
      case 'GEOIP': groups.geoip_set.push(value); noResolve = true; break
      case 'IP-ASN': groups.asn_set.push(value); break
      case 'URL-REGEX': groups.url_regex_set.push(value); break
      case 'USER-AGENT': groups.user_agent_set.push(value); break
      case 'DEST-PORT': groups.dest_port_set.push(value); break
      default:
        console.warn(`[egern] skip unsupported rule in ${name}.list: ${rule}`)
    }
  }

  const quote = (v: string): string => (/[^A-Za-z0-9.\/_-]/.test(v) ? `"${v}"` : v)

  const lines = [
    '# Egern rule set',
    `# Source: ${name}.list`,
    `# Policy: ${policy}`,
    `# Generated: ${now}`,
  ]
  if (noResolve) lines.push('no_resolve: true')
  for (const [key, values] of Object.entries(groups) as [keyof EgernGroups, string[]][]) {
    if (!values.length) continue
    lines.push(`${key}:`)
    for (const v of [...new Set(values)].sort()) lines.push(`  - ${quote(v)}`)
  }
  lines.push('')
  return lines.join('\n')
}

// ── Shadowrocket / Surge 风格 .list ─────────────────────────────
function genShadowrocket(name: string, rules: string[], policy: string): string {
  return [
    '# Shadowrocket / Surge rule set',
    `# Source: ${name}.list`,
    `# Policy: ${policy}`,
    `# Generated: ${now}`,
    ...rules,
    '',
  ].join('\n')
}

// ── 懒人配置：Clash ─────────────────────────────────────────────
function genClashLazy(): string {
  const providers = RULE_SETS.map(
    ({ name, policy }) =>
      `  ${name}:\n` +
      `    type: http\n` +
      `    behavior: classical\n` +
      `    url: ${BASE_URL}/clash/${name}.yaml\n` +
      `    path: ./rules/${name}.yaml\n` +
      `    interval: 86400`
  ).join('\n')

  const rules = [
    ...RULE_SETS.map(({ name, policy }) => `  - RULE-SET,${name},${policy}`),
    '  - GEOIP,CN,DIRECT',
    '  - MATCH,PROXY',
  ].join('\n')

  return `# ════════════════════════════════════════════════════════════════
#  Teakowa Rules · Clash 懒人配置（自动生成，请勿手动修改）
#  规则集每日自动更新：${BASE_URL}/clash/
# ════════════════════════════════════════════════════════════════

mixed-port: 7890
allow-lan: false
mode: rule
log-level: info

# ── 步骤一：填入你的节点（二选一）────────────────────────────────
# 方式 A：使用订阅（推荐），把下方 url 换成你的机场订阅链接
proxy-providers:
  Airport:
    type: http
    url: "https://your-subscribe-url/sub"
    interval: 86400
    path: ./providers/airport.yaml
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 300

# 方式 B：不使用订阅，直接在这里填节点
proxies:
  # - name: "示例节点"
  #   type: ss
  #   server: example.com
  #   port: 8388
  #   cipher: aes-128-gcm
  #   password: "password"

# ── 代理组（若用方式 B，把 use 改成 proxies 列表）────────────────
proxy-groups:
  - name: PROXY
    type: select
    use: [Airport]
    proxies: [DIRECT]
  - name: AUTO
    type: url-test
    use: [Airport]
    url: https://www.gstatic.com/generate_204
    interval: 300

# ── 规则集（自动更新，无需修改）─────────────────────────────────
rule-providers:
${providers}

rules:
${rules}
`
}

// ── 懒人配置：Egern ─────────────────────────────────────────────
function genEgernLazy(): string {
  const ruleSets = [
    ...RULE_SETS.map(
      ({ egernName, policy }) =>
        `  - rule_set:\n` +
        `      match: ${BASE_URL}/egern/${egernName}.yaml\n` +
        `      policy: ${policy}\n` +
        `      update_interval: 86400`
    ),
    '  - geoip:\n      match: CN\n      policy: DIRECT\n      no_resolve: true',
    '  - default:\n      policy: PROXY',
  ].join('\n')

  return `# ════════════════════════════════════════════════════════════════
#  Teakowa Rules · Egern 懒人配置（自动生成，请勿手动修改）
#  规则集每日自动更新：${BASE_URL}/egern/
# ════════════════════════════════════════════════════════════════

http_port: 6152
socks_port: 6153

# ── 步骤一：填入你的订阅链接 ─────────────────────────────────────
policy_groups:
  - external:
      name: Airport
      type: select
      urls:
        - "https://your-subscribe-url/sub"
      hidden: false
  - select:
      name: PROXY
      policies:
        - Airport
        - DIRECT
  - auto_test:
      name: AUTO
      policies:
        - Airport
      url: https://www.gstatic.com/generate_204
      interval: 300
      tolerance: 0

# ── 规则（自动更新，无需修改）───────────────────────────────────
rules:
${ruleSets}
`
}

// ── 懒人配置：Shadowrocket ──────────────────────────────────────
function genShadowrocketLazy(): string {
  const rules = [
    ...RULE_SETS.map(
      ({ name, policy }) => `RULE-SET,${BASE_URL}/shadowrocket/${name}.list,${policy}`
    ),
    'GEOIP,CN,DIRECT',
    'FINAL,PROXY',
  ].join('\n')

  return `# ════════════════════════════════════════════════════════════════
#  Teakowa Rules · Shadowrocket 懒人配置（自动生成，请勿手动修改）
#  规则集每日自动更新：${BASE_URL}/shadowrocket/
# ════════════════════════════════════════════════════════════════

[General]
loglevel = notify
dns-server = 8.8.8.8, 223.5.5.5
ipv6 = false

[Proxy]
# 节点请通过「订阅」添加

[Rule]
${rules}
`
}

// ── 主流程 ──────────────────────────────────────────────────────
function main(): void {
  for (const { file, name, egernName, policy } of RULE_SETS) {
    const rules = parseRules(file)
    mkdirSync(join(DIST, 'clash'), { recursive: true })
    mkdirSync(join(DIST, 'egern'), { recursive: true })
    mkdirSync(join(DIST, 'shadowrocket'), { recursive: true })

    writeFileSync(join(DIST, 'clash', `${name}.yaml`), genClash(name, rules, policy))
    writeFileSync(join(DIST, 'egern', `${egernName}.yaml`), genEgern(name, rules, policy))
    writeFileSync(join(DIST, 'shadowrocket', `${name}.list`), genShadowrocket(name, rules, policy))
    console.log(`[ok] ${name} -> ${rules.length} rules (${policy})`)
  }

  writeFileSync(join(DIST, 'clash', 'lazy.yaml'), genClashLazy())
  writeFileSync(join(DIST, 'egern', 'lazy.yaml'), genEgernLazy())
  writeFileSync(join(DIST, 'shadowrocket', 'lazy.conf'), genShadowrocketLazy())
  console.log('[ok] lazy configs -> clash/egern/shadowrocket')
}

main()
