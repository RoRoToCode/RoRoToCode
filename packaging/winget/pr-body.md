## 📖 Description

First version of **RoRoToCode.RoRoToCode**.

RoRoTo Code is a Windows local coding agent built around llama.cpp / GGUF. It inspects the machine,
picks a backend (CUDA / Vulkan / CPU), derives launch parameters from a real GGUF header instead of
guessing from parameter count, and wraps the local-model failure modes (startup failures, crashes,
repetition loops, bad sampler values).

- Package: `RoRoToCode.RoRoToCode` version `0.1.3`
- License: MIT — https://github.com/RoRoToCode/RoRoToCode/blob/main/LICENSE
- Project: https://github.com/RoRoToCode/RoRoToCode
- Installer: one self-contained exe, `InstallerType: portable`

Note on runtime downloads: on first use the application downloads llama.cpp binaries and a
user-selected GGUF model from third-party sources. Nothing third-party is bundled inside the
installer asset — the README lists each component and its license.

## ✅ Checklist

- [x] Signed the Contributor License Agreement
- [ ] Linked to an issue — not applicable, this is a new package

## 📦 Manifest Checklist

- [x] Checked that there aren't other open pull requests for the same manifest update/change
- [x] This PR only modifies one (1) manifest
- [x] Validated manifest locally with `winget validate --manifest <path>` — passes, exit 0 on winget v1.29.380
- [ ] Tested manifest locally with `winget install --manifest <path>` — not run on this machine: local
      manifest installation is disabled by policy (`winget settings --enable LocalManifestFiles` needs an
      administrator). Relying on the validation pipeline's sandbox install as the real end-to-end check.
- [x] Manifest is schema-valid — declared `ManifestVersion: 1.6.0`. Deliberate: raising the same files to
      `1.28.0` makes `winget validate` emit three `Schema header not found` warnings, while `1.6.0`
      validates clean.
