# Disciples PreCenter: Windows desktop app

This folder turns your PreCenter page (`app/index.html`) into a real Windows program with an
installer, a portable `.exe`, an editable settings file, and file associations for `.dscservice`
and `.dscitems`.

**Status.** The page code, the shell logic (settings, address rules, permissions, opening files,
NDI hand-off, program auto-update) and the icons were tested. The Windows `.exe` itself has **not** been
built or run yet, because that needs a Windows machine or GitHub. Do the first build, then run the
checklist at the bottom.

## 1. Get the installer (.exe)

### Option A: GitHub builds it for you (no setup on your PC)
1. Put this folder in a GitHub repository (it is public here, which free SignPath code signing needs).
2. Open the **Actions** tab, choose **Build Windows installer**, press **Run workflow**.
3. When it finishes (about 5 minutes), open the run and download **Disciples-PreCenter-Windows**.
   It holds `Disciples-PreCenter-Setup-<version>.exe` (installer), its `.blockmap`, `latest.yml`, and
   `Disciples-PreCenter-Portable-<version>.exe`.
4. To publish a release, push a tag like `v1.0.1` (see section 7). The files are attached to a GitHub
   release, and installed copies of the program find the update from it.

### Option B: build on your own Windows PC
1. Install **Node.js LTS** from https://nodejs.org.
2. Double-click `build-windows.bat` (or run `npm install` then `npm run dist` in a terminal here).
3. Your files appear in the `dist` folder.

### Just try it without building
`npm install` then `npm start` opens the app straight away.

## 2. The settings file

The first time the app runs it writes **`config.json`** to:

`%APPDATA%\Disciples PreCenter\config.json`  (or use **File > Open settings file** in the app)

Edit it in Notepad, save, and restart the app. Lines starting with `//` are notes. A mistake in the file
never stops the app: it uses the defaults for that run and tells you what was wrong. Delete the file to
get a fresh copy.

| Setting | What it does |
|---|---|
| `update` | `enabled` (default true) and `url`. While `mode` is `local`, the app looks at this hosted page on every start, downloads it if its version is higher, and uses it from the next start (Help > Check for page update does it on demand). Offline or on any problem the copy already on the computer is used. |
| `autoUpdate` | `true` (default) = the **installed** program checks GitHub Releases for a new version, downloads it quietly, and installs it when you close the app (never during a service). Not used by the portable version. Set `false` to turn it off. |
| `mode`, `startUrl` | `"local"` runs the copy inside the app (works offline). `"remote"` loads `startUrl` (a full https address, for example your hosted copy). If it cannot load, the built-in copy opens instead. |
| `siteUrl` | Your Disciples site, used by the Help menu. |
| `window` | Start size, whether it starts maximized, whether the slim title strip is used (`customTitleBar`), and whether the menu bar is always visible (otherwise press Alt). |
| `permissions` | What PreCenter may ask this computer for: camera and microphone, MIDI, pasting pictures, placing windows on other screens, full screen, screen sharing. `false` always refuses. |
| `corsRelaxHosts` | Web services PreCenter may call from the app's own address (your Disciples site for sign-in, the Bible and Planning Center services). Add a host only if a feature says it is blocked. |
| `externalLinks` | `"browser"` opens other links in your normal browser. `"block"` ignores them. |
| `offlineLibraries` | Uses a built-in copy of JSZip so saving a service as one file works with no internet. |
| `singleInstance` | A second launch brings the first window forward (and opens a file you double-clicked). |
| `devTools` | Allows F12 developer tools. Leave off for church use. |
| `ndi` | See "Turning on NDI". |
| `mirror` | `autoStart` (default true): starts the live view for other devices every time the app opens; set `false` to share only when you choose File > Share live view. Links are in File > Share live view, and in `mirror-links.txt` in the data folder. The code stays the same between runs (file `mirror-code.txt`). |

Logs are in `%APPDATA%\Disciples PreCenter\logs\main.log`.

## 3. How the app handles addresses (URLs)

* PreCenter runs from its own address, `dsc://app/`, not from a file path. That is what lets sign-in,
  saving, pop-up windows and the Audience/Stage screens behave as they do on the web.
* The Audience, Stage, Identify and Remote windows are allowed to open. Web links (for example SongSelect)
  open in your browser. Anything else (`file:`, `javascript:` and so on) is refused.
* The main window cannot be navigated away from the app.
* Sign-in asks your Disciples site for its settings. The app adds the permission headers for the hosts in
  `corsRelaxHosts` so that works from `dsc://app`. **Risk:** if your Firebase key is restricted to certain
  website addresses, sign-in from `dsc://app` may be refused. If that happens, either allow it in the Firebase
  console or set `"mode": "remote"` with `startUrl` pointing at your hosted copy.

## 4. Opening files

Double-clicking a `.dscservice` or `.dscitems` file (or "Open with") opens it in PreCenter, the same as
choosing it from the File menu inside the app. The app asks before replacing your current service.

## 5. Turning on NDI (optional, not tested)

NDI is **off** in this build, so the installer builds reliably. The app side is ready: Screens set to
NDI are handed to the shell, which opens a hidden window per screen and sends its frames.

To try it on a Windows PC:
1. Install **NDI Tools** from https://ndi.video.
2. In this folder run `npm install grandiose` (a native add-on; it needs the Visual Studio Build Tools),
   then `npx @electron/rebuild`. Other NDI bindings also work: only `ndi/sender.js` talks to the binding,
   and its method names must match the one you install.
3. In `config.json` set `"ndi": { "enabled": true }`, restart, and set a screen's output to NDI under Screens.
4. Check it in NDI Studio Monitor. Read NDI's licence and trademark terms before you share the app.

Not included: NDI audio. 4K at 60 fps may be too heavy for the way frames are copied.

## 6. First-run checklist (after your first build)

- [ ] The installer runs, makes a Start menu entry and a desktop shortcut, and the app opens with the logo icon.
- [ ] `config.json` appears in `%APPDATA%\Disciples PreCenter`. Change `window.width`, restart, see it apply.
- [ ] Sign-in works (see the risk in section 3).
- [ ] **Audience** opens on the projector (Extend displays) and **Stage** on its own screen, fullscreen, with no title strip.
- [ ] Pasting a screenshot into the slide editor works.
- [ ] **File > Save service to computer** writes one `.dscservice` file; double-clicking it opens it.
- [ ] Camera/microphone/MIDI prompts behave as set in `permissions`.
- [ ] Program update works: install `v1.0.1`, publish `v1.0.2`, open the app, and after a minute the
      "Update is ready" notice appears. Close the app, open it again, and it is the new version.
- [ ] Windows SmartScreen shows "unknown publisher" for an unsigned build: choose **More info > Run anyway**.
  Code signing (see section 7) removes that warning.

## 7. Updating

There are two kinds of update.

**The page (`app/index.html`)**
Publish the new page to your hosted site with a higher `DSC_VERSION`. The app picks it up on the next start
(see the `update` and `mode` settings). No new installer is needed.

**The program itself (`main.js`, `preload.js`, `lib/`, settings defaults)**
1. Change the files and commit them to `main`.
2. Publish a GitHub release with a new tag, for example `v1.0.2`. (Releases > Draft a new release > type the new
   tag > Publish.) Do not attach files yourself: the workflow builds them and attaches the installer,
   its `.blockmap` and `latest.yml`. The workflow sets the program version from the tag.
3. Installed copies check GitHub every few hours, download the new version quietly (only the changed parts),
   and install it when the app is closed. A small "Update is ready" notice appears in the main window.

Notes:
* A computer needs the first auto-update-capable version (`v1.0.1` or later) installed by hand once. After that,
  updates arrive on their own.
* Automatic program updates work for the **Setup** installer only, not the Portable file.
* The new version never replaces the running one during a service. It installs when the app closes.
* Make sure `latest.yml` is in the release's file list. Without it, installed copies cannot see the update.
* Settings and saved data are kept across updates.

**Code signing (SignPath Foundation)**
The project is open source (GPL-3.0) and applies for free signing from SignPath Foundation. The certificate is
issued to SignPath Foundation. Free code signing provided by SignPath.io, certificate by SignPath Foundation.
After approval, a signing step is added to the workflow so the Setup installer is signed before it is released.

## 8. Troubleshooting

* **Blank window**: open `logs\main.log`; or set `"mode": "local"` in `config.json`.
* **"Settings were not used" message**: your `config.json` has a typo; the message names it.
* **A web feature is blocked**: add its host to `corsRelaxHosts`.
* **Antivirus flags the `.exe`**: it is unsigned and new; sign it or add an exception.
* **Windows were placed on the wrong screen**: make sure `window-management` is `true` and the screens are set to Extend.
* **The program does not update**: check `logs\main.log` for lines starting with `updater:`. Make sure the release has
  `latest.yml` attached, the tag is higher than the installed version, and `autoUpdate` is `true`.
