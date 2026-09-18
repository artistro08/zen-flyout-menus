# Flyout Menus

Makes right-click menus and submenus in Zen roll out of nowhere exactly like Windows 11 (WinUI) flyouts, Mica backdrop included, with no blank flash on open.

## Introduction

Zen's context menus pop in fully formed, and with Mica on, the empty backdrop shows a frame or two before the contents. This mod replaces that with the Windows 11 flyout animation:

- The menu's top edge stays put, the menu grows downward, and the contents slide down with its bottom edge. Measured frame by frame from the Edge context menu: 250ms, `cubic-bezier(0, 0, 0, 1)`.
- Menus that open upward because there's no room below the cursor roll the other way: the bottom edge stays at the cursor, the menu grows upward, and the contents slide up with its top edge.
- The whole menu rolls out, Mica backdrop included, not just the contents. The script resizes the menu's actual window each frame.
- No blank flash. The window is hidden from the compositor until its contents are painted.
- Respects your OS "reduce motion" setting (menus then behave like stock Zen).

## Installing with Sine

### Prerequisites

- Zen Browser on Windows 11
- [Sine](https://github.com/CosmoCreeper/Sine) installed

1. Open Zen settings and go to the Sine page.
2. In the "Install from GitHub" box, paste:

```
artistro08/zen-flyout-menus
```

3. Click install, then restart Zen once so the script loads. Updates come through Sine when this repo changes.

> The script is required. CSS cannot resize or hide a menu's window, and the Mica backdrop is drawn from that window's bounds. The script does that part through js-ctypes and Win32 (`SetWindowPos`, `DwmSetWindowAttribute`).

## Installing without Sine

1. Open `about:profiles`, then "Open Folder" next to the profile in use.
2. Open `zen-themes.json` in that folder (create it with `{}` if missing) and add this entry inside the outer braces:

```json
"7c2f1b3e-5a9d-4e61-9f0b-2d8c4a6e1b57": {
  "id": "7c2f1b3e-5a9d-4e61-9f0b-2d8c4a6e1b57",
  "name": "Flyout Menus",
  "description": "Right-click menus roll out like Windows 11 flyouts.",
  "homepage": "https://github.com/artistro08/zen-flyout-menus",
  "style": "https://raw.githubusercontent.com/artistro08/zen-flyout-menus/main/chrome.css",
  "readme": "https://raw.githubusercontent.com/artistro08/zen-flyout-menus/main/readme.md",
  "author": "Artistro08",
  "version": "4.1.0",
  "enabled": true
}
```

3. Zen Mods only load the CSS, so you also need [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) or Sine to run `flyout-menus.uc.js`.

## How It Works

1. On `popupshowing` the menu's OS window already exists but is hidden. The script cloaks it (`DWMWA_CLOAK`) so nothing shows yet.
2. The script waits until Firefox has shown, sized and painted the real menu at full size, still hidden.
3. A stand-in window with the same Mica backdrop shows a live copy of the menu (a DWM thumbnail, the same thing taskbar previews use). Windows draws the copy itself, so Firefox renders nothing during the roll and there's never an empty strip. The stand-in grows each frame and shows the matching slice of the menu. It lets clicks through to the real menu, so clicking mid-roll still works.
4. The stand-in stays up for as long as the menu is open, following the real menu if it changes size, and the real menu stays hidden underneath. Handing back to the real menu would mean switching its backdrop back on, and Windows shows a flat backdrop while it rebuilds the blur. When the menu closes, the stand-in is removed and the real menu is put back to normal once Firefox has hidden it.

> Why not just resize Firefox's menu window? Windows shows the bigger window before Firefox has drawn the new part, which leaves a blank strip at the growing edge on larger menus.

## Known Limits

- Windows only. On other platforms the script does nothing.
- A menu's very first open in a session starts a few frames later than later opens, while it finishes filling in.

## Tweaking

At the top of `flyout-menus.uc.js`:

```js
let duration = 250;
```

That's it!
