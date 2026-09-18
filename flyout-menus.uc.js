// Flyout Menus
// Rolls right-click menus out of nowhere the way Windows 11 (WinUI) flyouts
// do: the menu window's top edge stays put, the window grows downward, and the
// contents slide down with its bottom edge. 250ms, decelerate curve
// cubic-bezier(0, 0, 0, 1), measured frame by frame from the Edge context menu.
//
// How it works. Firefox cannot resize or hide a popup's OS window from CSS, and
// the Mica backdrop is drawn from that window's bounds, so this talks to Win32
// through js-ctypes:
//   1. popupshowing: the menu's window already exists but is hidden. It is
//      cloaked (DWMWA_CLOAK) so the compositor never shows it empty. On a cold
//      open, when the window is not known yet, every hidden popup window is
//      cloaked and the others are released one frame later.
//   2. chrome.css sets appearance: none on menus so Firefox never applies the
//      Mica backdrop itself. The backdrop and rounded corners are applied here
//      while the window is still cloaked.
//   3. The window stays cloaked until its contents have painted once. Then it
//      is shrunk to 1px, uncloaked, and grown back to full height frame by
//      frame (SetWindowPos) while the contents translate down.
(function () {
    // Settings
    let duration    = 250;
    let reduced     = matchMedia("(prefers-reduced-motion)").matches;
    let mica_popups = matchMedia("(-moz-windows-mica-popups)").matches;

    if (reduced || navigator.platform !== "Win32") {
        return;
    }

    // Win32
    let { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    let user32     = ctypes.open("user32.dll");
    let dwmapi     = ctypes.open("dwmapi.dll");
    let HWND       = ctypes.voidptr_t;
    let RECT       = new ctypes.StructType("RECT", [{ left: ctypes.int32_t }, { top: ctypes.int32_t }, { right: ctypes.int32_t }, { bottom: ctypes.int32_t }]);

    let FindWindowExW         = user32.declare("FindWindowExW", ctypes.winapi_abi, HWND, HWND, HWND, ctypes.char16_t.ptr, ctypes.char16_t.ptr);
    let GetWindow             = user32.declare("GetWindow", ctypes.winapi_abi, HWND, HWND, ctypes.uint32_t);
    let GetWindowRect         = user32.declare("GetWindowRect", ctypes.winapi_abi, ctypes.int32_t, HWND, RECT.ptr);
    let IsWindow              = user32.declare("IsWindow", ctypes.winapi_abi, ctypes.int32_t, HWND);
    let IsWindowVisible       = user32.declare("IsWindowVisible", ctypes.winapi_abi, ctypes.int32_t, HWND);
    let SetWindowPos          = user32.declare("SetWindowPos", ctypes.winapi_abi, ctypes.int32_t, HWND, HWND, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.int32_t, ctypes.uint32_t);
    let DwmSetWindowAttribute = dwmapi.declare("DwmSetWindowAttribute", ctypes.winapi_abi, ctypes.int32_t, HWND, ctypes.uint32_t, ctypes.voidptr_t, ctypes.uint32_t);

    let GW_OWNER                       = 4;
    let DWMWA_CLOAK                    = 13;
    let DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    let DWMWA_SYSTEMBACKDROP_TYPE      = 38;
    let DWMWCP_ROUND                   = 2;
    let DWMSBT_TRANSIENTWINDOW         = 4;
    let POPUP_CLASS                    = "MozillaDropShadowWindowClass";
    let SWP_RESIZE_ONLY                = 0x0004 | 0x0010 | 0x0100 | 0x0200 | 0x0400; // NOZORDER | NOACTIVATE | NOCOPYBITS | NOOWNERZORDER | NOSENDCHANGING

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

    function dwmInt(hwnd, attribute, value) {
        let boxed = ctypes.int32_t(value);
        DwmSetWindowAttribute(hwnd, attribute, boxed.address(), 4);
    }

    function cloak(hwnd, on) {
        dwmInt(hwnd, DWMWA_CLOAK, on ? 1 : 0);
    }

    function isOurPopupWindow(hwnd) {
        return IsWindow(hwnd) && keyOf(GetWindow(hwnd, GW_OWNER)) === main_key;
    }

    function matchesRect(hwnd, rect, dpr) {
        let r = RECT();
        GetWindowRect(hwnd, r.address());
        return Math.abs(r.left - Math.round(rect.left * dpr)) <= 2 && Math.abs(r.top - Math.round(rect.top * dpr)) <= 2;
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

    // Run once the menu's contents have been painted, with a fallback if no paint event comes
    function afterPaint(callback) {
        let done     = false;
        let run      = () => {
            if (done) {
                return;
            }
            done = true;
            window.removeEventListener("MozAfterPaint", on_paint);
            requestAnimationFrame(callback);
        };
        let on_paint = () => run();

        window.addEventListener("MozAfterPaint", on_paint);
        setTimeout(run, 120);
    }

    // Roll The Menu Out
    function rollOut(popup) {
        let dpr = window.devicePixelRatio;

        // Force layout so the popup window is positioned at its final spot
        popup.getBoundingClientRect();

        if (popup.state !== "open" && popup.state !== "showing") {
            releaseOthers(popup, null);
            return;
        }

        let rect = popup.getOuterScreenRect();

        // On a cold start the popup can take a frame or two to get its size
        if (!(rect.height > 0)) {
            popup._zenFlyoutTries = (popup._zenFlyoutTries || 0) + 1;
            if (popup._zenFlyoutTries < 10) {
                popup._zenFlyoutFrame = requestAnimationFrame(() => rollOut(popup));
                return;
            }
        }
        popup._zenFlyoutTries = 0;

        let cached = windows.get(popup);
        let hwnd   = cached && isOurPopupWindow(cached) && matchesRect(cached, rect, dpr) ? cached : popupWindows(h => matchesRect(h, rect, dpr))[0];

        releaseOthers(popup, hwnd);

        if (!hwnd) {
            return;
        }

        windows.set(popup, hwnd);
        cloak(hwnd, true);

        if (mica_popups) {
            dwmInt(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_TRANSIENTWINDOW);
            dwmInt(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND);
        }

        let bounds = RECT();
        GetWindowRect(hwnd, bounds.address());

        let x          = bounds.left;
        let y          = bounds.top;
        let width      = bounds.right - bounds.left;
        let height     = bounds.bottom - bounds.top;
        let height_css = rect.height;
        let inner      = popup.shadowRoot && popup.shadowRoot.querySelector("[part~=content]");
        let start      = null;
        let shown_h    = 0;
        let revealed   = false;

        function resize(h) {
            SetWindowPos(hwnd, null, x, y, width, Math.max(1, h), SWP_RESIZE_ONLY);
        }

        function reveal() {
            if (!revealed) {
                revealed = true;
                cloak(hwnd, false);
            }
        }

        function step(now) {
            if (popup.state !== "open" && popup.state !== "showing") {
                return;
            }

            if (start === null) {
                start = now;
            }

            let progress = Math.min((now - start) / duration, 1);
            let eased    = ease(progress);
            let h        = Math.round(height * eased);

            // Uncloak one frame after the window first has height, once that size has painted
            if (shown_h > 1) {
                reveal();
            }

            resize(h);
            shown_h = h;

            if (inner) {
                inner.style.translate = "0 " + ((eased - 1) * height_css) + "px";
            }

            if (progress < 1) {
                popup._zenFlyoutFrame = requestAnimationFrame(step);
            } else {
                popup._zenFlyoutFrame = requestAnimationFrame(() => {
                    popup._zenFlyoutFrame = null;
                    resize(height);
                    reveal();
                    if (inner) {
                        inner.style.translate = "";
                    }
                });
            }
        }

        // Let the contents paint once at full size (still cloaked), then roll
        afterPaint(() => {
            if (popup.state !== "open" && popup.state !== "showing") {
                return;
            }

            resize(1);

            if (inner) {
                inner.style.translate = "0 " + (-height_css) + "px";
            }

            popup._zenFlyoutFrame = requestAnimationFrame(step);
        });
    }

    // Hide The Menu Window Before It Shows
    function onShowing(event) {
        let popup = event.target;
        if (popup.localName !== "menupopup") {
            return;
        }

        // The window is created before this event. Use the one seen last time,
        // else cloak every hidden popup window and sort it out next frame.
        let cached = windows.get(popup);
        let hidden = cached && isOurPopupWindow(cached) ? [cached] : popupWindows(h => !IsWindowVisible(h));

        for (let hwnd of hidden) {
            cloak(hwnd, true);
        }

        popup._zenFlyoutCloaked = hidden;
        popup._zenFlyoutFrame   = requestAnimationFrame(() => rollOut(popup));
    }

    // Put The Menu Window Back To Normal On Close
    function onHidden(event) {
        let popup = event.target;
        if (popup.localName !== "menupopup") {
            return;
        }

        if (popup._zenFlyoutFrame) {
            cancelAnimationFrame(popup._zenFlyoutFrame);
            popup._zenFlyoutFrame = null;
        }

        let inner = popup.shadowRoot && popup.shadowRoot.querySelector("[part~=content]");
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
    root.setAttribute("zen-flyout-ready", "");
    root.addEventListener("popupshowing", onShowing, true);
    root.addEventListener("popuphidden", onHidden, true);

    // Clean up when Sine disables or uninstalls the mod
    window.addUnloadListener?.(() => {
        root.removeAttribute("zen-flyout-ready");
        root.removeEventListener("popupshowing", onShowing, true);
        root.removeEventListener("popuphidden", onHidden, true);
        user32.close();
        dwmapi.close();
    });
})();
