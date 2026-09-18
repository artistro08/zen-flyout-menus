// Flyout Menus
// Rolls right-click menus out of nowhere the way Windows 11 (WinUI) flyouts
// do: the menu's top edge stays put, the menu grows downward, and the contents
// slide down with its bottom edge. Menus that Firefox flips upward (not enough
// room below the cursor) roll the other way: the bottom edge stays put and the
// menu grows upward. 250ms, decelerate curve cubic-bezier(0, 0, 0, 1), measured
// frame by frame from the Edge context menu.
//
// How it works. Firefox only renders a menu at its window's current size, so
// growing Firefox's own menu window frame by frame leaves an empty strip
// whenever Windows shows the bigger window before Firefox has rendered it. So
// the real menu never moves. Instead, through js-ctypes and Win32:
//   1. popupshowing: the menu's window already exists but is hidden. It is
//      cloaked (DWMWA_CLOAK) so nothing shows yet. On a cold open, when the
//      window is not known yet, every hidden popup window is cloaked and the
//      others are released once the right one is found.
//   2. The script waits until Firefox has shown, sized and painted the real
//      menu at full size (still cloaked, with Firefox's own Mica backdrop).
//   3. A stand-in window with the same backdrop shows a live copy of the menu
//      (a DWM thumbnail, the same thing taskbar previews use). Windows draws
//      the copy itself, so Firefox renders nothing during the roll. The
//      stand-in grows each frame and shows the matching slice of the menu.
//   4. When the roll ends, the real menu is uncloaked in exactly the same spot
//      and the stand-in is removed.
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
    let kernel32   = ctypes.open("kernel32.dll");
    let dwmapi     = ctypes.open("dwmapi.dll");
    let HWND       = ctypes.voidptr_t;
    let RECT       = new ctypes.StructType("RECT", [{ left: ctypes.int32_t }, { top: ctypes.int32_t }, { right: ctypes.int32_t }, { bottom: ctypes.int32_t }]);
    let POINT      = new ctypes.StructType("POINT", [{ x: ctypes.int32_t }, { y: ctypes.int32_t }]);
    let MARGINS    = new ctypes.StructType("MARGINS", [{ left: ctypes.int32_t }, { right: ctypes.int32_t }, { top: ctypes.int32_t }, { bottom: ctypes.int32_t }]);
    let WNDCLASSEX = new ctypes.StructType("WNDCLASSEXW", [
        { cbSize: ctypes.uint32_t },
        { style: ctypes.uint32_t },
        { lpfnWndProc: ctypes.voidptr_t },
        { cbClsExtra: ctypes.int32_t },
        { cbWndExtra: ctypes.int32_t },
        { hInstance: ctypes.voidptr_t },
        { hIcon: ctypes.voidptr_t },
        { hCursor: ctypes.voidptr_t },
        { hbrBackground: ctypes.voidptr_t },
        { lpszMenuName: ctypes.char16_t.ptr },
        { lpszClassName: ctypes.char16_t.ptr },
        { hIconSm: ctypes.voidptr_t },
    ]);
    let THUMBNAIL  = new ctypes.StructType("DWM_THUMBNAIL_PROPERTIES", [
        { dwFlags: ctypes.uint32_t },
        { rcDestination: RECT },
        { rcSource: RECT },
        { opacity: ctypes.uint8_t },
        { fVisible: ctypes.int32_t },
        { fSourceClientAreaOnly: ctypes.int32_t },
    ]);

    let FindWindowExW                = user32.declare("FindWindowExW", ctypes.winapi_abi, HWND, HWND, HWND, ctypes.char16_t.ptr, ctypes.char16_t.ptr);
    let GetCursorPos                 = user32.declare("GetCursorPos", ctypes.winapi_abi, ctypes.int32_t, POINT.ptr);
    let GetWindow                    = user32.declare("GetWindow", ctypes.winapi_abi, HWND, HWND, ctypes.uint32_t);
    let GetWindowRect                = user32.declare("GetWindowRect", ctypes.winapi_abi, ctypes.int32_t, HWND, RECT.ptr);
    let IsWindow                     = user32.declare("IsWindow", ctypes.winapi_abi, ctypes.int32_t, HWND);
    let IsWindowVisible              = user32.declare("IsWindowVisible", ctypes.winapi_abi, ctypes.int32_t, HWND);
    let SetWindowPos                 = user32.declare("SetWindowPos", ctypes.winapi_abi, ctypes.int32_t, HWND, HWND, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.uint32_t);
    let RegisterClassExW             = user32.declare("RegisterClassExW", ctypes.winapi_abi, ctypes.uint16_t, WNDCLASSEX.ptr);
    let CreateWindowExW              = user32.declare("CreateWindowExW", ctypes.winapi_abi, HWND, ctypes.uint32_t, ctypes.char16_t.ptr, ctypes.char16_t.ptr, ctypes.uint32_t, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, HWND, ctypes.voidptr_t, ctypes.voidptr_t, ctypes.voidptr_t);
    let SetLayeredWindowAttributes   = user32.declare("SetLayeredWindowAttributes", ctypes.winapi_abi, ctypes.int32_t, HWND, ctypes.uint32_t, ctypes.uint8_t, ctypes.uint32_t);
    let SendMessageW                 = user32.declare("SendMessageW", ctypes.winapi_abi, ctypes.intptr_t, HWND, ctypes.uint32_t, ctypes.uintptr_t, ctypes.intptr_t);
    let DestroyWindow                = user32.declare("DestroyWindow", ctypes.winapi_abi, ctypes.int32_t, HWND);
    let GetModuleHandleW             = kernel32.declare("GetModuleHandleW", ctypes.winapi_abi, ctypes.voidptr_t, ctypes.char16_t.ptr);
    let GetProcAddress               = kernel32.declare("GetProcAddress", ctypes.winapi_abi, ctypes.voidptr_t, ctypes.voidptr_t, ctypes.char.ptr);
    let DwmSetWindowAttribute        = dwmapi.declare("DwmSetWindowAttribute", ctypes.winapi_abi, ctypes.int32_t, HWND, ctypes.uint32_t, ctypes.voidptr_t, ctypes.uint32_t);
    let DwmGetWindowAttribute        = dwmapi.declare("DwmGetWindowAttribute", ctypes.winapi_abi, ctypes.int32_t, HWND, ctypes.uint32_t, ctypes.voidptr_t, ctypes.uint32_t);
    let DwmExtendFrameIntoClientArea = dwmapi.declare("DwmExtendFrameIntoClientArea", ctypes.winapi_abi, ctypes.int32_t, HWND, MARGINS.ptr);
    let DwmRegisterThumbnail         = dwmapi.declare("DwmRegisterThumbnail", ctypes.winapi_abi, ctypes.int32_t, HWND, HWND, ctypes.voidptr_t.ptr);
    let DwmUpdateThumbnailProperties = dwmapi.declare("DwmUpdateThumbnailProperties", ctypes.winapi_abi, ctypes.int32_t, ctypes.voidptr_t, THUMBNAIL.ptr);
    let DwmUnregisterThumbnail       = dwmapi.declare("DwmUnregisterThumbnail", ctypes.winapi_abi, ctypes.int32_t, ctypes.voidptr_t);

    let GW_OWNER                       = 4;
    let DWMWA_USE_IMMERSIVE_DARK_MODE  = 20;
    let DWMWA_TRANSITIONS_FORCEDISABLED = 3;
    let DWMWA_CLOAK                    = 13;
    let WM_NCACTIVATE                  = 0x0086;
    let DWMSBT_NONE                    = 1;
    let DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    let DWMWA_SYSTEMBACKDROP_TYPE      = 38;
    let DWM_TNP_ALL                    = 0x01 | 0x02 | 0x08 | 0x10; // destination, source, visible, client-area-only
    let WS_POPUP                       = 0x80000000;
    let WS_EX_STAND_IN                 = 0x00000080 | 0x08000000 | 0x00200000 | 0x00080000 | 0x00000020; // TOOLWINDOW | NOACTIVATE | NOREDIRECTIONBITMAP | LAYERED | TRANSPARENT (clicks pass through to the real menu)
    let LWA_ALPHA                      = 0x2;
    let SWP_SHOW_NOACTIVATE            = 0x0010 | 0x0040;                     // NOACTIVATE | SHOWWINDOW
    let SWP_PLACE                      = 0x0004 | 0x0010 | 0x0200;            // NOZORDER | NOACTIVATE | NOOWNERZORDER
    let POPUP_CLASS                    = "MozillaDropShadowWindowClass";
    let STAND_IN_CLASS                 = "ZenFlyoutMenusStandIn";
    let FLIP_SLACK_CSS                 = 24; // how far below the cursor a flipped menu's bottom edge can sit (submenus align to the item's bottom)
    let MAX_WAIT_FRAMES                = 12;
    let COLD_STEADY_FRAMES             = 5;  // frames a cold first open must hold its size before rolling
    let MAX_SETTLE_FRAMES              = 20;

    // Elements
    let root        = document.documentElement;
    let main_hwnd   = ctypes.cast(ctypes.uintptr_t(parseInt(window.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIAppWindow).docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle, 16)), HWND);
    let main_key    = keyOf(main_hwnd);
    let windows     = new WeakMap();
    let stand_ins   = new Set();
    let class_name  = ctypes.char16_t.array()(STAND_IN_CLASS);
    let module      = GetModuleHandleW(null);

    // cubic-bezier(0, 0, 0, 1): x = s^3, y = 3s^2 - 2s^3
    function ease(progress) {
        let s = Math.cbrt(progress);
        return 3 * s * s - 2 * s * s * s;
    }

    // Win32 Helpers
    function keyOf(hwnd) {
        return String(ctypes.cast(hwnd, ctypes.uintptr_t).value);
    }

    function setDwmInt(hwnd, attribute, value) {
        let boxed = ctypes.int32_t(value);
        DwmSetWindowAttribute(hwnd, attribute, boxed.address(), 4);
    }

    function getDwmInt(hwnd, attribute, fallback) {
        let boxed = ctypes.int32_t(fallback);
        return DwmGetWindowAttribute(hwnd, attribute, boxed.address(), 4) === 0 ? boxed.value : fallback;
    }

    function cloak(hwnd, on) {
        setDwmInt(hwnd, DWMWA_CLOAK, on ? 1 : 0);
    }

    function isOurPopupWindow(hwnd) {
        return IsWindow(hwnd) && keyOf(GetWindow(hwnd, GW_OWNER)) === main_key;
    }

    function windowRect(hwnd) {
        let r = RECT();
        GetWindowRect(hwnd, r.address());
        return { left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top };
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

    // =========================================================================
    // STAND-IN WINDOW
    // =========================================================================

    // The stand-in's window class uses Windows' own default window procedure, so
    // no script ever runs inside a window message. Every browser window shares
    // the class, so it is registered once and never unregistered.
    function registerStandInClass() {
        let window_class           = WNDCLASSEX();
        window_class.cbSize        = WNDCLASSEX.size;
        window_class.lpfnWndProc   = GetProcAddress(GetModuleHandleW("user32.dll"), "DefWindowProcW");
        window_class.hInstance     = module;
        window_class.lpszClassName = class_name;
        RegisterClassExW(window_class.address());
    }

    function createWindow(rect) {
        return CreateWindowExW(WS_EX_STAND_IN, class_name, null, WS_POPUP, rect.left, rect.top, rect.width, 1, main_hwnd, null, module, null);
    }

    // A window that looks exactly like the menu's backdrop and shows a live copy
    // of the (hidden) real menu
    function createStandIn(menu_hwnd, rect) {
        let hwnd = createWindow(rect);
        if (hwnd.isNull()) {
            registerStandInClass();
            hwnd = createWindow(rect);
        }
        if (hwnd.isNull()) {
            return null;
        }

        // Fully opaque; the layered style is only there so clicks pass through
        SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);

        // Same backdrop, theme and corners as the real menu window
        let glass = MARGINS();
        glass.left = glass.right = glass.top = glass.bottom = -1;
        DwmExtendFrameIntoClientArea(hwnd, glass.address());
        setDwmInt(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, getDwmInt(menu_hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 0));
        setDwmInt(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, getDwmInt(menu_hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, 0));
        let backdrop = getDwmInt(menu_hwnd, DWMWA_SYSTEMBACKDROP_TYPE, 0);
        setDwmInt(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, backdrop);

        // No Windows fade when the stand-in appears or goes away
        setDwmInt(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, 1);

        // Draw the "active" backdrop like Firefox does for its menus. Without this
        // the stand-in starts with the dimmer inactive backdrop and then shifts.
        SendMessageW(hwnd, WM_NCACTIVATE, 1, -1);

        let thumbnail = ctypes.voidptr_t();
        if (DwmRegisterThumbnail(hwnd, menu_hwnd, thumbnail.address()) !== 0) {
            DestroyWindow(hwnd);
            return null;
        }

        // The copy would include the hidden menu's own backdrop, which Windows draws
        // flat and dark while the menu is hidden, on top of the stand-in's Mica. So
        // the real menu's backdrop is off during the roll and only its contents are
        // copied; it is switched back on just before the real menu takes over.
        setDwmInt(menu_hwnd, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_NONE);

        let stand_in = { hwnd, thumbnail, shown: false, menu_hwnd, backdrop, restored: false };
        stand_ins.add(stand_in);
        return stand_in;
    }

    // Size and place the stand-in, and show the matching slice of the menu in it
    function placeStandIn(stand_in, left, top, width, height, source_top) {
        let properties                   = THUMBNAIL();
        properties.dwFlags               = DWM_TNP_ALL;
        properties.rcDestination.left    = 0;
        properties.rcDestination.top     = 0;
        properties.rcDestination.right   = width;
        properties.rcDestination.bottom  = height;
        properties.rcSource.left         = 0;
        properties.rcSource.top          = source_top;
        properties.rcSource.right        = width;
        properties.rcSource.bottom       = source_top + height;
        properties.fVisible              = 1;
        properties.fSourceClientAreaOnly = 0;
        DwmUpdateThumbnailProperties(stand_in.thumbnail, properties.address());

        SetWindowPos(stand_in.hwnd, null, left, top, width, height, stand_in.shown ? SWP_PLACE : SWP_SHOW_NOACTIVATE);
        stand_in.shown = true;
    }

    function restoreMenuBackdrop(stand_in) {
        if (!stand_in.restored) {
            stand_in.restored = true;
            if (IsWindow(stand_in.menu_hwnd)) {
                setDwmInt(stand_in.menu_hwnd, DWMWA_SYSTEMBACKDROP_TYPE, stand_in.backdrop);
            }
        }
    }

    function destroyStandIn(stand_in) {
        restoreMenuBackdrop(stand_in);
        if (!stand_ins.has(stand_in)) {
            return;
        }
        stand_ins.delete(stand_in);
        DwmUnregisterThumbnail(stand_in.thumbnail);
        DestroyWindow(stand_in.hwnd);
    }

    // =========================================================================
    // MENU HELPERS
    // =========================================================================

    function isOpen(popup) {
        return popup.state === "open" || popup.state === "showing";
    }

    // The menu's size from layout, which is always current, in device pixels
    function layoutSize(popup) {
        let box = popup.getBoundingClientRect();
        let dpr = window.devicePixelRatio;
        return { width: Math.round(box.width * dpr), height: Math.round(box.height * dpr) };
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

    // =========================================================================
    // ROLL-OUT
    // =========================================================================

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
                let size = windowRect(h);
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
    // Firefox resizes the window itself when it does. The stand-in copies the
    // menu at the size it has when the roll starts, so wait (still cloaked) until
    // layout and window size hold steady: one repeat for a menu seen before,
    // several on a cold first open.
    function waitUntilSettled(popup, generation, hwnd, needed, previous, same, tries) {
        if (!isOpen(popup)) {
            cloak(hwnd, false);
            return;
        }

        let layout  = layoutSize(popup);
        let actual  = windowRect(hwnd);
        let reading = [layout.width, layout.height, actual.left, actual.top, actual.width, actual.height].join();
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

        // Where Firefox put the real menu, in device pixels. The roll ends exactly here.
        let rect   = windowRect(hwnd);
        let bottom = rect.top + rect.height;

        // Flipped upward: Firefox put the menu's bottom edge at the cursor instead of its top edge
        let click_y = popup._zenFlyoutCursorY;
        let upward  = click_y !== null && click_y !== undefined && rect.top < click_y && bottom <= click_y + FLIP_SLACK_CSS * window.devicePixelRatio;

        let stand_in = createStandIn(hwnd, rect);
        if (!stand_in) {
            // Could not animate: just show the menu
            cloak(hwnd, false);
            return;
        }

        let start    = null;
        let finished = false;

        // Downward: the top edge stays put and the menu's bottom slice shows, so the
        // contents slide down with the bottom edge. Upward: the bottom edge stays put
        // and the menu's top slice shows, so the contents slide up with the top edge.
        function show(height) {
            let h = Math.max(1, Math.min(rect.height, height));
            if (upward) {
                placeStandIn(stand_in, rect.left, bottom - h, rect.width, h, 0);
            } else {
                placeStandIn(stand_in, rect.left, rect.top, rect.width, h, rect.height - h);
            }
        }

        // Swap in the real menu. It is uncloaked first, identical and in the same
        // spot, and the stand-in is removed a couple of frames later so there is
        // never a frame with neither.
        function finish() {
            if (finished) {
                return;
            }
            finished = true;
            popup._zenFlyoutAnimating = null;

            if (!isOpen(popup)) {
                destroyStandIn(stand_in);
                return;
            }

            show(rect.height);
            restoreMenuBackdrop(stand_in);
            cloak(hwnd, false);
            requestAnimationFrame(() => requestAnimationFrame(() => destroyStandIn(stand_in)));
        }

        function step(now) {
            if (!isOpen(popup)) {
                finish();
                return;
            }

            if (start === null) {
                start = now;
            }

            let progress = Math.min((now - start) / duration, 1);
            show(Math.round(rect.height * ease(progress)));

            if (progress < 1) {
                nextFrame(popup, generation, step);
            } else {
                nextFrame(popup, generation, finish);
            }
        }

        popup._zenFlyoutAnimating = { finish };
        nextFrame(popup, generation, step);
    }

    // =========================================================================
    // EVENTS
    // =========================================================================

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

    // Put Everything Back On Close
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

        if (popup._zenFlyoutAnimating) {
            popup._zenFlyoutAnimating.finish();
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
        for (let stand_in of Array.from(stand_ins)) {
            destroyStandIn(stand_in);
        }
        user32.close();
        kernel32.close();
        dwmapi.close();
    });
})();
