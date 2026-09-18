// Flyout Menus
// Rolls right-click menus out of nowhere the way Windows 11 (WinUI) flyouts
// do: the menu window's top edge stays put, the window grows downward, and the
// contents slide down with its bottom edge. Menus that Firefox flips upward
// (not enough room below the cursor) roll the other way: the bottom edge stays
// put and the window grows upward. 250ms, decelerate curve
// cubic-bezier(0, 0, 0, 1), measured frame by frame from the Edge context menu.
//
// How it works. Firefox cannot resize or hide a popup's OS window from CSS, and
// the Mica backdrop is drawn from that window's bounds, so this talks to Win32
// through js-ctypes:
//   1. popupshowing: the menu's window already exists but is hidden. It is
//      cloaked (DWMWA_CLOAK) so the compositor never shows it half-painted. On
//      a cold open, when the window is not known yet, every hidden popup window
//      is cloaked and the others are released once the right one is found.
//   2. The script waits until Firefox has shown, sized and painted the window
//      (still cloaked). Firefox applies the Mica backdrop itself, as in stock Zen.
//   3. The window is shrunk to 1px, uncloaked, and grown back to full height
//      frame by frame with SetWindowPos. Firefox is never told about these
//      changes (see quietSetWindowPos), so it keeps painting the menu at full
//      size and the window simply shows more of it each frame. A downward roll
//      keeps the top edge and slides the contents down with the bottom edge. An
//      upward roll keeps the bottom edge and the contents ride the top edge.
//      Both end exactly where Firefox put the window.
(function () {
    // Settings
    let duration = 250;
    let reduced  = matchMedia("(prefers-reduced-motion)").matches;

    if (reduced || navigator.platform !== "Win32") {
        return;
    }

    // Win32
    let { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    let user32     = ctypes.open("user32.dll");
    let dwmapi     = ctypes.open("dwmapi.dll");
    let HWND       = ctypes.voidptr_t;
    let RECT       = new ctypes.StructType("RECT", [{ left: ctypes.int32_t }, { top: ctypes.int32_t }, { right: ctypes.int32_t }, { bottom: ctypes.int32_t }]);
    let POINT      = new ctypes.StructType("POINT", [{ x: ctypes.int32_t }, { y: ctypes.int32_t }]);

    let FindWindowExW         = user32.declare("FindWindowExW", ctypes.winapi_abi, HWND, HWND, HWND, ctypes.char16_t.ptr, ctypes.char16_t.ptr);
    let GetCursorPos          = user32.declare("GetCursorPos", ctypes.winapi_abi, ctypes.int32_t, POINT.ptr);
    let GetWindow             = user32.declare("GetWindow", ctypes.winapi_abi, HWND, HWND, ctypes.uint32_t);
    let GetWindowRect         = user32.declare("GetWindowRect", ctypes.winapi_abi, ctypes.int32_t, HWND, RECT.ptr);
    let IsWindow              = user32.declare("IsWindow", ctypes.winapi_abi, ctypes.int32_t, HWND);
    let IsWindowVisible       = user32.declare("IsWindowVisible", ctypes.winapi_abi, ctypes.int32_t, HWND);
    let SetWindowPos          = user32.declare("SetWindowPos", ctypes.winapi_abi, ctypes.int32_t, HWND, HWND, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.uint32_t);
    let SetWindowLongPtrW     = user32.declare("SetWindowLongPtrW", ctypes.winapi_abi, ctypes.intptr_t, HWND, ctypes.int32_t, ctypes.intptr_t);
    let CallWindowProcW       = user32.declare("CallWindowProcW", ctypes.winapi_abi, ctypes.intptr_t, ctypes.intptr_t, HWND, ctypes.uint32_t, ctypes.uintptr_t, ctypes.intptr_t);
    let DwmSetWindowAttribute = dwmapi.declare("DwmSetWindowAttribute", ctypes.winapi_abi, ctypes.int32_t, HWND, ctypes.uint32_t, ctypes.voidptr_t, ctypes.uint32_t);
    let WNDPROC               = ctypes.FunctionType(ctypes.stdcall_abi, ctypes.intptr_t, [HWND, ctypes.uint32_t, ctypes.uintptr_t, ctypes.intptr_t]);

    let GW_OWNER            = 4;
    let GWLP_WNDPROC        = -4;
    let WM_WINDOWPOSCHANGED = 0x0047;
    let DWMWA_CLOAK         = 13;
    let POPUP_CLASS     = "MozillaDropShadowWindowClass";
    let SWP_RESIZE_ONLY = 0x0002 | 0x0004 | 0x0010 | 0x0100 | 0x0200 | 0x0400; // NOMOVE | NOZORDER | NOACTIVATE | NOCOPYBITS | NOOWNERZORDER | NOSENDCHANGING
    let SWP_MOVE_RESIZE = 0x0004 | 0x0010 | 0x0100 | 0x0200 | 0x0400;          // same, but the window may move
    let FLIP_SLACK_CSS  = 24; // how far below the cursor a flipped menu's bottom edge can sit (submenus align to the item's bottom)
    let MAX_WAIT_FRAMES = 12;
    let COLD_STEADY_FRAMES = 5;  // frames a cold first open must hold its size before rolling
    let MAX_SETTLE_FRAMES  = 20;

    // Elements
    let root      = document.documentElement;
    let main_hwnd = ctypes.cast(ctypes.uintptr_t(parseInt(window.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIAppWindow).docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle, 16)), HWND);
    let main_key  = keyOf(main_hwnd);
    let windows   = new WeakMap();

    // cubic-bezier(0, 0, 0, 1): x = s^3, y = 3s^2 - 2s^3
    function ease(progress) {
        let s = Math.cbrt(progress);
        return 3 * s * s - 2 * s * s * s;
    }

    // Win32 Helpers
    function keyOf(hwnd) {
        return String(ctypes.cast(hwnd, ctypes.uintptr_t).value);
    }

    function cloak(hwnd, on) {
        let boxed = ctypes.int32_t(on ? 1 : 0);
        DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, boxed.address(), 4);
    }

    function isOurPopupWindow(hwnd) {
        return IsWindow(hwnd) && keyOf(GetWindow(hwnd, GW_OWNER)) === main_key;
    }

    function windowSize(hwnd) {
        let r = RECT();
        GetWindowRect(hwnd, r.address());
        return { left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top };
    }

    // Move or resize a menu window without Firefox finding out.
    // Firefox reacts to a moved menu by growing it back to full size, and to a
    // shrunk menu by repainting it smaller. Both fight the roll. For the length of
    // our own SetWindowPos call only, Firefox's window procedure is swapped for a
    // pass-through that drops WM_WINDOWPOSCHANGED, so Firefox keeps treating the
    // menu as full size where it put it. That is also where every roll ends.
    // The swap never outlives the call: script must not run inside Firefox's
    // window procedure at other times.
    let firefox_proc = null;
    let quiet_proc   = WNDPROC.ptr((hwnd, message, wparam, lparam) => {
        if (message === WM_WINDOWPOSCHANGED) {
            return 0;
        }
        return CallWindowProcW(firefox_proc, hwnd, message, wparam, lparam);
    });
    let quiet_value  = ctypes.cast(quiet_proc, ctypes.intptr_t);

    function quietSetWindowPos(hwnd, x, y, width, height, flags) {
        firefox_proc = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, quiet_value);
        try {
            SetWindowPos(hwnd, null, x, y, width, height, flags);
        } finally {
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, firefox_proc);
            firefox_proc = null;
        }
    }

    function resize(hwnd, width, height) {
        quietSetWindowPos(hwnd, 0, 0, width, Math.max(1, height), SWP_RESIZE_ONLY);
    }

    // Resize while keeping the bottom edge where it is. Returns false if the window
    // did not end up where asked, so the caller can roll downward instead.
    function resizeFromBottom(hwnd, left, bottom, width, height) {
        let h = Math.max(1, height);
        quietSetWindowPos(hwnd, left, bottom - h, width, h, SWP_MOVE_RESIZE);

        let now = windowSize(hwnd);
        return Math.abs(now.top - (bottom - h)) <= 1 && now.height === h;
    }

    function cursorY() {
        let point = POINT();
        return GetCursorPos(point.address()) ? point.y : null;
    }

    function popupWindows(test) {
        let found = [];
        let hwnd  = FindWindowExW(null, null, POPUP_CLASS, null);
        let n     = 0;
        while (!hwnd.isNull() && n++ < 500) {
            if (isOurPopupWindow(hwnd) && test(hwnd)) {
                found.push(hwnd);
            }
            hwnd = FindWindowExW(null, hwnd, POPUP_CLASS, null);
        }
        return found;
    }

    // Menu Helpers
    function isOpen(popup) {
        return popup.state === "open" || popup.state === "showing";
    }

    // The menu's size from layout, which is always current, in device pixels
    function layoutSize(popup) {
        let box = popup.getBoundingClientRect();
        let dpr = window.devicePixelRatio;
        return { width: Math.round(box.width * dpr), height: Math.round(box.height * dpr), height_css: box.height };
    }

    function contentOf(popup) {
        return popup.shadowRoot && popup.shadowRoot.querySelector("[part~=content]");
    }

    // Release every window cloaked on popupshowing except the menu's own
    function releaseOthers(popup, keep) {
        let keep_key = keep ? keyOf(keep) : null;
        for (let hwnd of popup._zenFlyoutCloaked || []) {
            if (keyOf(hwnd) !== keep_key && IsWindow(hwnd)) {
                cloak(hwnd, false);
            }
        }
        popup._zenFlyoutCloaked = null;
    }

    // Run on the next frame, but only if this open of the menu is still current
    function nextFrame(popup, generation, callback) {
        popup._zenFlyoutFrame = requestAnimationFrame(now => {
            if (popup._zenFlyoutGeneration === generation) {
                callback(now);
            }
        });
    }

    // Run once the menu's contents have painted, with a fallback if no paint event comes
    function afterPaint(popup, generation, callback) {
        let done     = false;
        let run      = () => {
            if (done) {
                return;
            }
            done = true;
            window.removeEventListener("MozAfterPaint", on_paint);
            nextFrame(popup, generation, callback);
        };
        let on_paint = () => run();

        window.addEventListener("MozAfterPaint", on_paint);
        setTimeout(run, 120);
    }

    // Find The Menu's Window
    // Wait until Firefox has shown the window and given it the menu's current size.
    function findWindow(popup, generation, tries) {
        if (!isOpen(popup)) {
            releaseOthers(popup, null);
            return;
        }

        let want = layoutSize(popup);
        let hwnd = null;

        if (want.height > 0) {
            hwnd = (popup._zenFlyoutCloaked || []).find(h => {
                if (!IsWindow(h) || !IsWindowVisible(h)) {
                    return false;
                }
                let size = windowSize(h);
                return Math.abs(size.width - want.width) <= 2 && Math.abs(size.height - want.height) <= 2;
            });
        }

        if (!hwnd && tries < MAX_WAIT_FRAMES) {
            nextFrame(popup, generation, () => findWindow(popup, generation, tries + 1));
            return;
        }

        releaseOthers(popup, hwnd);

        if (!hwnd) {
            return;
        }

        // First time this menu uses this window: it may still be filling in
        let known = windows.get(popup);
        let cold  = !known || keyOf(known) !== keyOf(hwnd);

        windows.set(popup, hwnd);
        afterPaint(popup, generation, () => waitUntilSettled(popup, generation, hwnd, cold ? COLD_STEADY_FRAMES : 1, null, 0, 0));
    }

    // Wait For The Menu To Stop Changing Size
    // On a cold first open a menu can still be filling in items and icons, and
    // Firefox resizes the window itself when it does. Starting the roll before that
    // would flash the full menu for a frame, so wait (still cloaked) until layout
    // and window size hold steady: one repeat for a menu seen before, several on a
    // cold first open.
    function waitUntilSettled(popup, generation, hwnd, needed, previous, same, tries) {
        if (!isOpen(popup)) {
            cloak(hwnd, false);
            return;
        }

        let layout  = layoutSize(popup);
        let actual  = windowSize(hwnd);
        let reading = [layout.width, layout.height, actual.width, actual.height].join();
        let steady  = reading === previous ? same + 1 : 0;

        if (steady >= needed || tries >= MAX_SETTLE_FRAMES) {
            rollOut(popup, generation, hwnd);
            return;
        }

        nextFrame(popup, generation, () => waitUntilSettled(popup, generation, hwnd, needed, reading, steady, tries + 1));
    }

    // Roll The Menu Out
    function rollOut(popup, generation, hwnd) {
        if (!isOpen(popup)) {
            cloak(hwnd, false);
            return;
        }

        // Firefox's exact window size, and how it lines up with layout. Only rounding
        // (a pixel or two) counts; a bigger gap means the menu grew after the window
        // was sized, and layout is the size to trust.
        let actual   = windowSize(hwnd);
        let layout   = layoutSize(popup);
        let offset_w = Math.abs(actual.width - layout.width) <= 2 ? actual.width - layout.width : 0;
        let offset_h = Math.abs(actual.height - layout.height) <= 2 ? actual.height - layout.height : 0;
        let inner    = contentOf(popup);
        let start    = null;
        let shown_h  = 0;
        let revealed = false;
        let last     = { width: actual.width, height: actual.height };

        // Flipped upward: Firefox put the menu's bottom edge at the cursor instead of its top edge
        let click_y  = popup._zenFlyoutCursorY;
        let bottom   = actual.top + actual.height;
        let upward   = click_y !== null && click_y !== undefined && actual.top < click_y && bottom <= click_y + FLIP_SLACK_CSS * window.devicePixelRatio;

        function place(width, height) {
            if (upward && !resizeFromBottom(hwnd, actual.left, bottom, width, height)) {
                // Firefox pinned it to its anchor, so roll downward from there instead
                upward = false;
            }

            if (!upward) {
                resize(hwnd, width, height);
            }
        }

        // Downward: the contents' bottom edge rides the window's bottom edge.
        // Upward: the contents' top edge rides the window's top edge, which is where
        // Firefox draws them anyway, so they need no offset.
        function slide(eased, height_css) {
            if (inner && !upward) {
                inner.style.translate = "0 " + ((eased - 1) * height_css) + "px";
            }
        }

        function reveal() {
            if (!revealed) {
                revealed = true;
                cloak(hwnd, false);
            }
        }

        // Always the current size, so menus that change size while opening are never cut off
        function target() {
            let now = layoutSize(popup);
            return { width: now.width + offset_w, height: now.height + offset_h, height_css: now.height_css };
        }

        // A closed menu has no layout size, so fall back to the last size seen while open
        function finish() {
            let full = isOpen(popup) ? target() : last;
            place(full.width, full.height);
            reveal();
            if (inner) {
                inner.style.translate = "";
            }
            popup._zenFlyoutAnimating = null;

            if (isOpen(popup)) {
                nextFrame(popup, generation, () => settle(30));
            }
        }

        // Menus can keep changing size right after opening (items and icons filled in
        // late), so keep the window matched to layout for a moment after the roll
        function settle(frames_left) {
            if (!isOpen(popup) || !IsWindow(hwnd)) {
                return;
            }

            let full = target();
            let now  = windowSize(hwnd);

            if (Math.abs(now.width - full.width) > 1 || Math.abs(now.height - full.height) > 1) {
                place(full.width, full.height);
            }

            if (frames_left > 0) {
                nextFrame(popup, generation, () => settle(frames_left - 1));
            }
        }

        function step(now) {
            if (!isOpen(popup)) {
                return;
            }

            if (start === null) {
                start = now;
            }

            // Uncloak at the size that has already painted, and hold it for this frame.
            // Growing in the same frame would show an unpainted strip at the leading edge.
            if (!revealed && shown_h > 1) {
                reveal();
                nextFrame(popup, generation, step);
                return;
            }

            let progress = Math.min((now - start) / duration, 1);
            let eased    = ease(progress);
            let full     = target();
            let h        = Math.round(full.height * eased);

            last = full;

            place(full.width, h);
            shown_h = h;
            slide(eased, full.height_css);

            if (progress < 1) {
                nextFrame(popup, generation, step);
            } else {
                nextFrame(popup, generation, finish);
            }
        }

        popup._zenFlyoutAnimating = { hwnd, finish };

        place(actual.width, 1);
        slide(0, layout.height_css);

        nextFrame(popup, generation, step);
    }

    // Hide The Menu Window Before It Shows
    function onShowing(event) {
        let popup = event.target;
        if (popup.localName !== "menupopup") {
            return;
        }

        let generation = (popup._zenFlyoutGeneration || 0) + 1;
        popup._zenFlyoutGeneration = generation;

        // The window is created before this event. Use the one seen last time,
        // else cloak every hidden popup window and sort it out once it shows.
        let cached = windows.get(popup);
        let hidden = cached && isOurPopupWindow(cached) ? [cached] : popupWindows(h => !IsWindowVisible(h));

        for (let hwnd of hidden) {
            cloak(hwnd, true);
        }

        popup._zenFlyoutCloaked = hidden;
        popup._zenFlyoutCursorY = cursorY();
        nextFrame(popup, generation, () => findWindow(popup, generation, 0));
    }

    // Put The Menu Window Back To Normal On Close
    function onHidden(event) {
        let popup = event.target;
        if (popup.localName !== "menupopup") {
            return;
        }

        // Any frame still queued for this open is now stale
        popup._zenFlyoutGeneration = (popup._zenFlyoutGeneration || 0) + 1;

        if (popup._zenFlyoutFrame) {
            cancelAnimationFrame(popup._zenFlyoutFrame);
            popup._zenFlyoutFrame = null;
        }

        // Closed mid-roll: give the window back its full size so Firefox's idea of it stays right
        if (popup._zenFlyoutAnimating) {
            popup._zenFlyoutAnimating.finish();
        }

        let inner = contentOf(popup);
        if (inner) {
            inner.style.translate = "";
        }

        releaseOthers(popup, null);

        let hwnd = windows.get(popup);
        if (hwnd && isOurPopupWindow(hwnd)) {
            cloak(hwnd, false);
        }
    }

    // Bind to Event Listeners
    root.addEventListener("popupshowing", onShowing, true);
    root.addEventListener("popuphidden", onHidden, true);

    // Clean up when Sine disables or uninstalls the mod
    window.addUnloadListener?.(() => {
        root.removeEventListener("popupshowing", onShowing, true);
        root.removeEventListener("popuphidden", onHidden, true);
        user32.close();
        dwmapi.close();
    });
})();
