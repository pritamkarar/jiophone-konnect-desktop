# Konnect — JioPhone Desktop Suite

[![Platform](https://img.shields.io/badge/platform-Linux-333?logo=linux)](https://github.com/pritamkarar/jiophone-konnect-desktop)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Konnect is a Linux desktop companion for JioPhone (KaiOS) devices over Bluetooth.** It turns a supported JioPhone into a practical desktop phone: make and receive calls, manage contacts, browse call history, record calls, and export reports — without relying on AT-command or OBEX protocol implementations inside the app.

> **Status:** Experimental / hardware-focused project. Developed and tested with a **LYF JioPhone F120B on Ubuntu 24.04**. Other JioPhone/KaiOS models may behave differently.

## ✨ Features

- **📞 Calls** — Dial numbers, answer and hang up calls, send DTMF tones, and view live call state and duration. Hold, resume, swap and merge calls; answer a second call while on the first; put a call on hold to dial another.
- **🔔 Incoming-call popup** — Get a desktop notification with contact lookup for incoming calls.
- **👤 Contacts** — Import contacts from the phone over Bluetooth OBEX.
- **🕘 Call history** — Search call logs, view statistics, and access recently dialled numbers from the tray menu.
- **🎙️ Call recording** — Capture call audio with `pw-record` and play recordings with a waveform view.
- **📤 Export** — Export calls and contacts to CSV, contacts to vCard, and generate a PDF report.
- **☁️ Optional Google integration** — Sign in, read Google Contacts, and back up Konnect recordings to Google Drive.
- **🧙 Setup wizard** — Checks the required Linux services and guides you through fixing common Bluetooth/telephony configuration problems.
- **🧪 Mock backend** — Run the complete UI without a physical phone for development and testing.

## 🖥️ Supported platform

| Platform | Status |
| --- | --- |
| **Linux** | ✅ Supported |
| Windows | ⚠️ Stub backend only |
| macOS | ❌ Not supported |

The supported configuration uses these Linux components:

- **oFono** — HFP telephony, dialing, call control, network state, and battery state
- **BlueZ `obexd`** — Bluetooth OBEX contact transfer
- **PipeWire / WirePlumber** — SCO call audio
- **Electron** — Desktop UI and application shell

Konnect intentionally stays thin around these system services. It does **not** implement the Bluetooth HFP/OBEX protocols itself or parse modem AT commands.

## 🚫 Known limitations

### SMS
SMS is **not supported** on the tested LYF JioPhone F120B. The handset does not advertise the Bluetooth MAP profile required for SMS messaging, so a desktop SMS client cannot be implemented through the available Bluetooth services alone.

### Phonebook pull
PBAP phonebook retrieval is not available on the tested handset. Contacts therefore arrive by the phone **pushing** them to the computer over OBEX rather than the desktop pulling the address book.

### Hardware compatibility
Bluetooth profiles and firmware behavior vary between JioPhone models. A device that is not the tested F120B may require additional work or may not expose the required profiles at all.

### Own phone number
The F120B does not report its subscriber number over HFP (the SIM carries no MSISDN), so Konnect cannot show it. A handset that does report one shows it in Settings.

### Recording with two calls
One recorder runs at a time and follows the audio link. While a second call is up, its audio lands in the first call's recording until that call ends; the second call then gets a recorder of its own.

## 🚀 Quick start

### 1. Clone the repository

```bash
git clone https://github.com/pritamkarar/jiophone-konnect-desktop.git
cd jiophone-konnect-desktop
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start Konnect

For the real handset:

```bash
make dev
```

For UI development without a phone:

```bash
make mock
```

Run the test suite with:

```bash
make test
```

Build Linux packages with:

```bash
make dist
```

The build produces an **AppImage** and a **`.deb`** package in `dist/`.

## 🔧 First-time setup

On first launch, Konnect checks the host configuration needed for telephony:

1. `oFono` is installed.
2. The `oFono` service is running.
3. PipeWire/WirePlumber is configured so `oFono` can own the Bluetooth HFP modem.
4. The handset's HFP modem is online.

The PipeWire/WirePlumber configuration is particularly important. On the tested setup, the native PipeWire HFP backend can otherwise claim the RFCOMM channel needed by oFono, preventing the modem from coming online.

The setup wizard shows the commands needed to repair the configuration when the privileged automatic path is unavailable. The implementation lives in `src/main/setup.js`.

## 🧪 Mock mode

Mock mode lets you exercise the desktop UI without a JioPhone:

```bash
make mock
```

You can also shape the simulated environment with these variables:

| Variable | Purpose |
| --- | --- |
| `KONNECT_MOCK=1` | Enable the mock backend |
| `KONNECT_MOCK_NO_PHONE=1` | Simulate a scan with no compatible handset |
| `KONNECT_MOCK_BT_OFF=1` | Simulate Bluetooth being powered off |
| `KONNECT_MOCK_INCOMING=<ms>` | Trigger a simulated incoming call after `<ms>` milliseconds |
| `KONNECT_MOCK_INCOMING_NUMBER=<number>` | Set the simulated caller number |

Example:

```bash
KONNECT_MOCK=1 KONNECT_MOCK_INCOMING=3000 KONNECT_MOCK_INCOMING_NUMBER=+919876543210 npm start
```

## 🛠️ Development

Konnect is an Electron application with a small platform backend abstraction.

```text
src/main/             Electron main process, IPC, tray, calls, persistence
src/main/backend/     Linux, mock and Windows backend implementations
src/renderer/         Desktop UI: dialer, calls, contacts, settings, onboarding
src/shared/           Shared phone-number, vCard, waveform and speed-dial logic
test/                 Node.js test suites
scripts/              Manual hardware verification probes
docs/                 Design and implementation documentation
assets/               Application assets and icons
```

The backend contract is defined in:

```text
src/main/backend/interface.js
```

Adding another platform means implementing that interface without changing the rest of the application architecture.

## 🔍 Hardware verification

The repository includes manual probes for validating the Bluetooth/telephony stack against a real paired phone.

Examples:

```bash
make verify-device
make verify-telephony ARGS=+919876543210
make verify-recording
make verify-pairing-agent
```

These probes communicate with real host services and hardware; they are separate from the automated unit tests.

## ☁️ Optional Google integration

Google integration is optional. Without credentials, Konnect starts normally and simply leaves Google features unconfigured.

To enable it, place an OAuth client file at:

```text
~/.config/konnect/google.json
```

Konnect requests narrow permissions:

- `contacts.readonly` — read Google Contacts; Konnect does not write to your address book.
- `drive.file` — access Drive files created by Konnect.

## 📁 Data locations

| Location | Contents |
| --- | --- |
| `~/Konnect/recordings` | Call recordings |
| `<electron userData>/konnect.db` | Contacts, call logs and application settings |
| `~/.config/konnect/google.json` | Optional Google OAuth client configuration |

Review these locations before sharing a machine or backup, because call recordings and call metadata can contain sensitive information.

## 📦 Build & release

The project uses `electron-builder` to create Linux packages.

```bash
make dist
```

For a release upload using GitHub credentials:

```bash
make dist ARGS="--publish always"
```

The repository's release workflow watches the package version. Bumping the version in `package.json` is what triggers a release build.

## 🧑‍💻 Contributing

Contributions are welcome, especially for:

- testing additional JioPhone models and Ubuntu/Linux releases
- improving device detection and Bluetooth compatibility
- documenting setup steps for different PipeWire/WirePlumber configurations
- improving the mock backend and automated tests
- adding support for additional desktop platforms

Before opening a pull request, run:

```bash
make test
```

For hardware-related changes, also run the relevant `verify-*` probe against a real supported handset.

## ⚠️ Disclaimer

This is an independent open-source project and is **not affiliated with or endorsed by Jio, Reliance Industries, LYF, or KaiOS Technologies**.

Bluetooth profile support depends on the phone firmware, Linux distribution, and installed services. Results may vary by device and system configuration.

## 📄 License

Released under the **MIT License**. See [LICENSE](LICENSE) for details.

## ⭐ Support the project

If Konnect is useful to you, consider giving the repository a **star**. Bug reports, hardware compatibility reports, documentation improvements, and pull requests are especially valuable for expanding support beyond the tested JioPhone F120B setup.
