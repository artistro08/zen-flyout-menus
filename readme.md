# Flyout Menus

Makes right-click menus and submenus in Zen pop in like Windows 11 flyouts: a quick fade plus a short slide, using the same decelerate easing WinUI uses.

## Introduction

Zen's context menus appear instantly. This mod animates the menu content on open:

- Top-level menus fade in and slide down from the click point.
- Submenus fade in and slide in from the left.
- Animation is 200ms and respects your OS "reduce motion" setting.

## Installing with Sine

### Prerequisites

- Zen Browser on Windows
- [Sine](https://github.com/CosmoCreeper/Sine) installed

1. Open Zen settings and go to the Sine page.
2. In the "Install from GitHub" box, paste:

```
artistro08/zen-flyout-menus
```

3. Click install. Sine downloads `chrome.css` and `flyout-menus.uc.js` and enables the mod. Updates come through Sine when this repo changes.

> The script is required. Firefox keeps a menu's layout alive after it closes, so a CSS-only animation plays once and never again. The script tags each menu while it is open so the animation replays every time.

> With Mica popups on (Zen's default), the blurred backdrop appears instantly and only the menu content animates. Set `widget.windows.mica.popups` to `0` in `about:config` if you want the whole menu to move together, at the cost of the Mica look.


## Installing without Sine

1. Open `about:profiles`, then "Open Folder" next to the profile in use.
2. Open `zen-themes.json` in that folder (create it with `{}` if missing) and add this entry inside the outer braces:

```json
"7c2f1b3e-5a9d-4e61-9f0b-2d8c4a6e1b57": {
  "id": "7c2f1b3e-5a9d-4e61-9f0b-2d8c4a6e1b57",
  "name": "Flyout Menus",
  "description": "Right-click menus and submenus pop in like WinUI flyouts.",
  "homepage": "https://github.com/artistro08/zen-flyout-menus",
  "style": "https://raw.githubusercontent.com/artistro08/zen-flyout-menus/main/chrome.css",
  "readme": "https://raw.githubusercontent.com/artistro08/zen-flyout-menus/main/readme.md",
  "author": "Artistro08",
  "version": "1.0.0",
  "enabled": true
}
```

3. Restart Zen. It downloads `chrome.css` on startup and the mod shows up under Settings > Zen Mods.

## Tweaking

Edit the tokens at the top of `chrome.css`:

```css
:root {
  --flyout-duration: 200ms;
  --flyout-easing: cubic-bezier(0.1, 0.9, 0.2, 1);
  --flyout-offset: 10px;
}
```

That's it!
