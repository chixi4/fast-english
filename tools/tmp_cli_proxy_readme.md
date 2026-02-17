# CLI Proxy API

English | [中文](README_CN
.md)

A proxy server that provides OpenAI/Gem
ini/Claude/Codex compatible API interfaces fo
r CLI.

It now also supports OpenAI Codex (GP
T models) and Claude Code via OAuth.

So you 
can use local or multi-account CLI access wit
h OpenAI(include Responses)/Gemini/Claude-com
patible clients and SDKs.

## Sponsor

[![z.a
i](https://assets.router-for.me/english-4.7.p
ng)](https://z.ai/subscribe?ic=8JVLJQFSKB)

T
his project is sponsored by Z.ai, supporting 
us with their GLM CODING PLAN.

GLM CODING PL
AN is a subscription service designed for AI 
coding, starting at just $3/month. It provide
s access to their flagship GLM-4.7 model acro
ss 10+ popular AI coding tools (Claude Code, 
Cline, Roo Code, etc.), offering developers t
op-tier, fast, and stable coding experiences.


Get 10% OFF GLM CODING PLAN：https://z.ai/
subscribe?ic=8JVLJQFSKB

---

<table>
<tbody>

<tr>
<td width="180"><a href="https://www.pa
ckyapi.com/register?aff=cliproxyapi"><img src
="./assets/packycode.png" alt="PackyCode" wid
th="150"></a></td>
<td>Thanks to PackyCode fo
r sponsoring this project! PackyCode is a rel
iable and efficient API relay service provide
r, offering relay services for Claude Code, C
odex, Gemini, and more. PackyCode provides sp
ecial discounts for our software users: regis
ter using <a href="https://www.packyapi.com/r
egister?aff=cliproxyapi">this link</a> and en
ter the "cliproxyapi" promo code during recha
rge to get 10% off.</td>
</tr>
<tr>
<td width
="180"><a href="https://cubence.com/signup?co
de=CLIPROXYAPI&source=cpa"><img src="./assets
/cubence.png" alt="Cubence" width="150"></a><
/td>
<td>Thanks to Cubence for sponsoring thi
s project! Cubence is a reliable and efficien
t API relay service provider, offering relay 
services for Claude Code, Codex, Gemini, and 
more. Cubence provides special discounts for 
our software users: register using <a href="h
ttps://cubence.com/signup?code=CLIPROXYAPI&so
urce=cpa">this link</a> and enter the "CLIPRO
XYAPI" promo code during recharge to get 10% 
off.</td>
</tr>
<tr>
<td width="180"><a href=
"https://www.aicodemirror.com/register?invite
code=TJNAIF"><img src="./assets/aicodemirror.
png" alt="AICodeMirror" width="150"></a></td>

<td>Thanks to AICodeMirror for sponsoring th
is project! AICodeMirror provides official hi
gh-stability relay services for Claude Code /
 Codex / Gemini CLI, with enterprise-grade co
ncurrency, fast invoicing, and 24/7 dedicated
 technical support. Claude Code / Codex / Gem
ini official channels at 38% / 2% / 9% of ori
ginal price, with extra discounts on top-ups!
 AICodeMirror offers special benefits for CLI
ProxyAPI users: register via <a href="https:/
/www.aicodemirror.com/register?invitecode=TJN
AIF">this link</a> to enjoy 20% off your firs
t top-up, and enterprise customers can get up
 to 25% off!</td>
</tr>
</tbody>
</table>

##
 Overview

- OpenAI/Gemini/Claude compatible 
API endpoints for CLI models
- OpenAI Codex s
upport (GPT models) via OAuth login
- Claude 
Code support via OAuth login
- Qwen Code supp
ort via OAuth login
- iFlow support via OAuth
 login
- Amp CLI and IDE extensions support w
ith provider routing
- Streaming and non-stre
aming responses
- Function calling/tools supp
ort
- Multimodal input support (text and imag
es)
- Multiple accounts with round-robin load
 balancing (Gemini, OpenAI, Claude, Qwen and 
iFlow)
- Simple CLI authentication flows (Gem
ini, OpenAI, Claude, Qwen and iFlow)
- Genera
tive Language API Key support
- AI Studio Bui
ld multi-account load balancing
- Gemini CLI 
multi-account load balancing
- Claude Code mu
lti-account load balancing
- Qwen Code multi-
account load balancing
- iFlow multi-account 
load balancing
- OpenAI Codex multi-account l
oad balancing
- OpenAI-compatible upstream pr
oviders via config (e.g., OpenRouter)
- Reusa
ble Go SDK for embedding the proxy (see `docs
/sdk-usage.md`)

## Getting Started

CLIProxy
API Guides: [https://help.router-for.me/](htt
ps://help.router-for.me/)

## Management API


see [MANAGEMENT_API.md](https://help.router-
for.me/management/api)

## Amp CLI Support

C
LIProxyAPI includes integrated support for [A
mp CLI](https://ampcode.com) and Amp IDE exte
nsions, enabling you to use your Google/ChatG
PT/Claude OAuth subscriptions with Amp's codi
ng tools:

- Provider route aliases for Amp's
 API patterns (`/api/provider/{provider}/v1..
.`)
- Management proxy for OAuth authenticati
on and account features
- Smart model fallbac
k with automatic routing
- **Model mapping** 
to route unavailable models to alternatives (
e.g., `claude-opus-4.5` → `claude-sonnet-4`
)
- Security-first design with localhost-only
 management endpoints

**→ [Complete Amp CL
I Integration Guide](https://help.router-for.
me/agent-client/amp-cli.html)**

## SDK Docs


- Usage: [docs/sdk-usage.md](docs/sdk-usage.
md)
- Advanced (executors & translators): [do
cs/sdk-advanced.md](docs/sdk-advanced.md)
- A
ccess: [docs/sdk-access.md](docs/sdk-access.m
d)
- Watcher: [docs/sdk-watcher.md](docs/sdk-
watcher.md)
- Custom Provider Example: `examp
les/custom-provider`

## Contributing

Contri
butions are welcome! Please feel free to subm
it a Pull Request.

1. Fork the repository
2.
 Create your feature branch (`git checkout -b
 feature/amazing-feature`)
3. Commit your cha
nges (`git commit -m 'Add some amazing featur
e'`)
4. Push to the branch (`git push origin 
feature/amazing-feature`)
5. Open a Pull Requ
est

## Who is with us?

Those projects are b
ased on CLIProxyAPI:

### [vibeproxy](https:/
/github.com/automazeio/vibeproxy)

Native mac
OS menu bar app to use your Claude Code & Cha
tGPT subscriptions with AI coding tools - no 
API keys needed

### [Subtitle Translator](ht
tps://github.com/VjayC/SRT-Subtitle-Translato
r-Validator)

Browser-based tool to translate
 SRT subtitles using your Gemini subscription
 via CLIProxyAPI with automatic validation/er
ror correction - no API keys needed

### [CCS
 (Claude Code Switch)](https://github.com/kai
tranntt/ccs)

CLI wrapper for instant switchi
ng between multiple Claude accounts and alter
native models (Gemini, Codex, Antigravity) vi
a CLIProxyAPI OAuth - no API keys needed

###
 [ProxyPal](https://github.com/heyhuynhgiabuu
/proxypal)

Native macOS GUI for managing CLI
ProxyAPI: configure providers, model mappings
, and endpoints via OAuth - no API keys neede
d.

### [Quotio](https://github.com/nguyenphu
trong/quotio)

Native macOS menu bar app that
 unifies Claude, Gemini, OpenAI, Qwen, and An
tigravity subscriptions with real-time quota 
tracking and smart auto-failover for AI codin
g tools like Claude Code, OpenCode, and Droid
 - no API keys needed.

### [CodMate](https:/
/github.com/loocor/CodMate)

Native macOS Swi
ftUI app for managing CLI AI sessions (Codex,
 Claude Code, Gemini CLI) with unified provid
er management, Git review, project organizati
on, global search, and terminal integration. 
Integrates CLIProxyAPI to provide OAuth authe
ntication for Codex, Claude, Gemini, Antigrav
ity, and Qwen Code, with built-in and third-p
arty provider rerouting through a single prox
y endpoint - no API keys needed for OAuth pro
viders.

### [ProxyPilot](https://github.com/
Finesssee/ProxyPilot)

Windows-native CLIProx
yAPI fork with TUI, system tray, and multi-pr
ovider OAuth for AI coding tools - no API key
s needed.

### [Claude Proxy VSCode](https://
github.com/uzhao/claude-proxy-vscode)

VSCode
 extension for quick switching between Claude
 Code models, featuring integrated CLIProxyAP
I as its backend with automatic background li
fecycle management.

### [ZeroLimit](https://
github.com/0xtbug/zero-limit)

Windows deskto
p app built with Tauri + React for monitoring
 AI coding assistant quotas via CLIProxyAPI. 
Track usage across Gemini, Claude, OpenAI Cod
ex, and Antigravity accounts with real-time d
ashboard, system tray integration, and one-cl
ick proxy control - no API keys needed.

### 
[CPA-XXX Panel](https://github.com/ferretgeek
/CPA-X)

A lightweight web admin panel for CL
IProxyAPI with health checks, resource monito
ring, real-time logs, auto-update, request st
atistics and pricing display. Supports one-cl
ick installation and systemd service.

### [C
LIProxyAPI Tray](https://github.com/kitephp/C
LIProxyAPI_Tray)

A Windows tray application 
implemented using PowerShell scripts, without
 relying on any third-party libraries. The ma
in features include: automatic creation of sh
ortcuts, silent running, password management,
 channel switching (Main / Plus), and automat
ic downloading and updating.

> [!NOTE]  
> I
f you developed a project based on CLIProxyAP
I, please open a PR to add it to this list.


## More choices

Those projects are ports of 
CLIProxyAPI or inspired by it:

### [9Router]
(https://github.com/decolua/9router)

A Next.
js implementation inspired by CLIProxyAPI, ea
sy to install and use, built from scratch wit
h format translation (OpenAI/Claude/Gemini/Ol
lama), combo system with auto-fallback, multi
-account management with exponential backoff,
 a Next.js web dashboard, and support for CLI
 tools (Cursor, Claude Code, Cline, RooCode) 
- no API keys needed.

> [!NOTE]  
> If you h
ave developed a port of CLIProxyAPI or a proj
ect inspired by it, please open a PR to add i
t to this list.

## License

This project is 
licensed under the MIT License - see the [LIC
ENSE](LICENSE) file for details.


