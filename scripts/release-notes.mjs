import { readFileSync, writeFileSync } from 'fs'
import {
  generateDownloadLinksMarkdown,
  getDownloadUrl,
  getProcessedVersion,
  isDevBuild
} from './version-utils.mjs'

const changelog = readFileSync('changelog.md', 'utf-8')
const version = getProcessedVersion()
const isDev = isDevBuild()
const downloadUrl = getDownloadUrl(isDev, version)

console.log(`📦 生成 Release Notes...`)
console.log(`版本号: ${version}`)
console.log(`构建类型: ${isDev ? 'dev' : 'release'}`)
console.log(`下载地址: ${downloadUrl}`)

const downloadLinks = generateDownloadLinksMarkdown(downloadUrl, version)
const releaseNotes = `${changelog}${downloadLinks}`

writeFileSync('release-notes.md', releaseNotes)

console.log(`✅ 已生成 release-notes.md`)
