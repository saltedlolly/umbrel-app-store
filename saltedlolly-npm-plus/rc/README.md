# NPMplus Companion Apps Integration Framework

## Documentation Index

This directory contains comprehensive documentation for the NPMplus companion apps integration framework.

### Quick Links

- **[Architecture Overview](architecture/OVERVIEW.md)** - System design and components
- **[Implementation Guide](guides/IMPLEMENTATION.md)** - How to build and deploy
- **[API Reference](api/ENDPOINTS.md)** - API endpoints and data formats
- **[Testing Guide](testing/TEST-PLAN.md)** - Test scenarios and procedures

---

## What Is This Framework?

NPMplus for Umbrel features a **zero-configuration companion app framework** that automatically detects and integrates with security and authentication apps. When you install CrowdSec or Authentik alongside NPMplus, they automatically connect and work together.

### Key Features

✅ **Auto-Discovery** - Detects companion apps at startup  
✅ **Smart Notifications** - Alerts you when new integrations become available  
✅ **Zero Configuration** - No manual config file editing required  
✅ **GUI Management** - All settings via web interface  
✅ **Independent Apps** - Each app works standalone  
✅ **Secure by Default** - Localhost-only ports, read-only log sharing

---

## Supported Integrations

### 🚨 CrowdSec Security Engine

**What it provides:**
- Intrusion detection and prevention
- IP reputation blocking
- WAF (Web Application Firewall) protection
- Community-sourced threat intelligence

**How it connects:**
- NPMplus logs → CrowdSec for behavioral analysis
- CrowdSec LAPI → NPMplus bouncer for blocking decisions
- CrowdSec AppSec → NPMplus for WAF protection

### 🔐 Authentik SSO Provider (Coming Soon)

**What it provides:**
- Single sign-on (SSO) authentication
- OAuth2/OIDC identity provider
- Centralized user management
- Multi-factor authentication

**How it connects:**
- NPMplus uses Authentik as OAuth2 provider
- Proxy hosts can require SSO authentication
- Automatic client registration

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│ 1. User installs NPMplus + CrowdSec                         │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. NPMplus container starts                                 │
│    └─→ entrypoint-wrapper.sh runs                           │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Auto-Discovery Phase                                     │
│    ├─→ Ping CrowdSec: host.docker.internal:8080/health      │
│    └─→ Ping Authentik: host.docker.internal:9000/...        │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Load User Preferences                                    │
│    └─→ Read /data/config/npm-settings.env                   │
│        ├─→ CROWDSEC_ENABLED: auto|true|false                │
│        └─→ AUTHENTIK_ENABLED: auto|true|false               │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Configure Integrations                                   │
│    ├─→ CrowdSec: Update /data/crowdsec/crowdsec.conf        │
│    │   ├─→ ENABLED=true                                     │
│    │   ├─→ API_KEY=${BOUNCER_KEY}                           │
│    │   └─→ APPSEC_URL=http://host.docker.internal:7422      │
│    │                                                         │
│    └─→ Authentik: Export OIDC environment variables         │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. NPMplus Starts                                           │
│    └─→ With integrations configured and ready               │
└─────────────────────────────────────────────────────────────┘
```

---

## User Experience

### Scenario 1: Install Together (Smooth)

```
1. User installs NPMplus
2. User installs CrowdSec
3. Both apps start
4. NPMplus auto-detects CrowdSec during startup
5. Integration is automatically enabled
6. User sees "✓ Detected and connected" in launcher
```

### Scenario 2: Install Later (Smart Notification)

```
1. NPMplus is already running
2. User installs CrowdSec
3. NPMplus launcher (if open) shows notification within 30s:
   
   ╔════════════════════════════════════════════════════╗
   ║ 🎉 CrowdSec Security Engine Detected!              ║
   ║                                                    ║
   ║ Restart NPMplus to enable security protection.    ║
   ║                                                    ║
   ║ How to restart:                                    ║
   ║  1. Go to Umbrel dashboard                         ║
   ║  2. Click NPMplus app tile                         ║
   ║  3. Click ⋮ menu → Restart                        ║
   ║                                              [×]   ║
   ╚════════════════════════════════════════════════════╝

4. User restarts NPMplus
5. Auto-discovery runs and enables integration
6. User sees "✓ Detected and connected"
```

---

## Documentation Structure

```
rc/
├── README.md (this file)
│
├── architecture/
│   ├── OVERVIEW.md           - System architecture
│   ├── AUTO-DISCOVERY.md     - How detection works
│   ├── SECURITY-MODEL.md     - Security design
│   └── CONFIGURATION.md      - Config file structure
│
├── guides/
│   ├── IMPLEMENTATION.md     - Build and deploy guide
│   ├── CROWDSEC.md          - CrowdSec integration details
│   ├── AUTHENTIK.md         - Authentik integration (future)
│   └── TROUBLESHOOTING.md   - Common issues and solutions
│
├── api/
│   ├── ENDPOINTS.md         - REST API reference
│   └── DATA-FORMATS.md      - Request/response schemas
│
└── testing/
    ├── TEST-PLAN.md         - Comprehensive test scenarios
    └── MANUAL-TESTS.md      - Step-by-step test procedures
```

---

## Quick Start

### For Users

1. **Install NPMplus** from Umbrel App Store
2. **Install CrowdSec** (optional) for security
3. **Open NPMplus launcher** - integration auto-enables
4. **Configure proxy hosts** as normal

### For Developers

1. **Read**: [Architecture Overview](architecture/OVERVIEW.md)
2. **Build**: [Implementation Guide](guides/IMPLEMENTATION.md)
3. **Test**: [Test Plan](testing/TEST-PLAN.md)
4. **Deploy**: Update images and versions

---

## Version History

- **v2026-09-26.01** - Companion apps framework + smart notifications
- **v2026-09-25.11** - Trusted proxy configuration UI
- **v2026-09-25.01** - Initial release

---

## Contributing

To add a new companion app integration:

1. Follow the pattern in [Implementation Guide](guides/IMPLEMENTATION.md)
2. Add detection in `entrypoint-wrapper.sh`
3. Add UI section in launcher
4. Add API endpoint in server.js
5. Document in this directory

---

## Support

- **Issues**: [GitHub Issues](https://github.com/saltedlolly/umbrel-app-store/issues)
- **Discussions**: [GitHub Discussions](https://github.com/saltedlolly/umbrel-app-store/discussions)
- **Documentation**: This `/rc` directory
