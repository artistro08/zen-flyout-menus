# Flyout Menus

Right-click menus in Zen roll out like Windows 11 flyouts. A [Sine](https://github.com/CosmoCreeper/Sine) mod.

## Introduction

Zen's context menus just appear, and with Mica on you get a frame or two of empty backdrop before the items show up. This mod rolls them out instead. The top edge stays where you clicked, the menu grows downward, and the items slide down with the bottom edge. 250ms on a decelerate curve, measured frame by frame off the Edge context menu. Menus that flip upward because there's no room below the cursor roll the other way.

### Prerequisites

- Windows 11
- Zen Browser with Sine installed
- `sine.allow-unsafe-js` set to `true` in `about:config` (this mod runs JavaScript)

## Install

1. Open Sine's mod marketplace in Zen settings.
2. Paste `artistro08/zen-flyout-menus` into the install box.
3. Restart Zen.

That's it!

## What it does

- Rolls out every context menu and submenu, Mica backdrop and all.
- Keeps Zen's stock look. The only styling is menu text size, a little bigger than Firefox's default.
- Clicking an item mid-roll still works, and hover highlights track like normal.
- Sits out when Windows is set to reduce motion, or when it can't reach the Windows APIs it needs.

## How it works

Firefox only draws a menu at its window's current size, so growing that window frame by frame leaves an empty strip every time Windows shows the bigger window before Firefox has drawn it. The Mica backdrop belongs to the window too, so CSS can't touch any of this.

So the real menu never moves. It stays hidden, and a stand-in window with the same backdrop shows a live copy of it — a DWM thumbnail, the same thing taskbar previews use. Windows draws the copy, so Firefox renders nothing while it rolls. The stand-in grows each frame, shows the matching slice of the menu, and lets clicks through to the real menu underneath.

It sticks around until the menu closes. Handing back means switching the real menu's backdrop on again, and Windows flashes flat grey while it rebuilds the blur.

## Files

- `flyout-menus.uc.js`: the mod. Roll speed is `duration` at the top.
- `chrome.css`: menu text size, as `--flyout-menu-font-size`. Item spacing isn't in here because Firefox's own menu rules beat a mod stylesheet.

> Both files get replaced on update. To keep your own values, set them again in your `userChrome.css`.

> A menu's first open in a session starts a few frames later than the rest, while it finishes filling in its items.
