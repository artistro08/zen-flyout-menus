# Flyout Menus

Makes right-click menus and submenus in Zen slide in exactly like Windows 11 tray flyouts.

## Introduction

Zen's context menus appear instantly. This mod moves the whole menu window into place the way Windows does it:

- Top-level menus slide down 60px into place. Submenus slide in 60px from the left.
- 330ms with the WinUI decelerate curve, `cubic-bezier(0, 0, 0, 1)`. Measured frame by frame from a recording of the Windows 11 tray menu.
- The whole window moves, Mica backdrop included, because the script moves the OS window itself instead of animating CSS inside it.
- Respects your OS "reduce motion" setting.

## Installing with Sine

### Prerequisites

- Zen Browser on Windows
- [Sine](https://github.com/CosmoCreeper/Sine) installed

1. Open Zen settings and go to the Sine page.
2. In the "Install from GitHub" box, paste:

```
artistro08/zen-flyout-menus
```

3. Click install, then restart Zen once so the script loads. Updates come through Sine when this repo changes.

> The script is required. CSS cannot move a menu's window, and the Mica backdrop lives on that window, so the script slides the window itself.

## Installing without Sine

1. Open `about:profiles`, then "Open Folder" next to the profile in use.
2. Open `zen-themes.json` in that folder (create it with `{}` if missing) and add this entry inside the outer braces:

```json
"7c2f1b3e-5a9d-4e61-9f0b-2d8c4a6e1b57": {
  "id": "7c2f1b3e-5a9d-4e61-9f0b-2d8c4a6e1b57",
  "name": "Flyout Menus",
  "description": "Right-click menus and submenus slide in like Windows 11 flyouts.",
  "homepage": "https://github.com/artistro08/zen-flyout-menus",
  "style": "https://raw.githubusercontent.com/artistro08/zen-flyout-menus/main/chrome.css",
  "readme": "https://raw.githubusercontent.com/artistro08/zen-flyout-menus/main/readme.md",
  "author": "Artistro08",
  "version": "2.0.0",
  "enabled": true
}
```

3. Zen Mods only load the CSS, so you also need [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) or Sine to run `flyout-menus.uc.js`.

## The Blank Flash On Open

With Mica popups on (Zen's default), Firefox shows the Mica window one or two frames before it paints the menu contents. That is Firefox behavior, not this mod, and it cannot be hidden: turning Mica on late blanks the window for a frame or two just the same.

If the flash bothers you more than the blur helps, open `about:config` and set `widget.windows.mica.popups` to `0`. Menus then draw with a normal translucent background, appear with their contents already painted, and still slide.

## Tweaking

Slide distance and speed live at the top of `flyout-menus.uc.js`:

```js
let duration = 330;
let offset   = 60;
```

That's it!
