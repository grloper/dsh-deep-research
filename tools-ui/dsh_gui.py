"""Generic DSH GUI driver helpers (uiautomation)."""
import sys
import time
import uiautomation as auto

def connect():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    win = auto.WindowControl(searchDepth=1, SubName="DeepSeek Harness")
    if not win.Exists(3):
        print("WINDOW NOT FOUND")
        sys.exit(2)
    win.SetActive()
    win.SetFocus()
    time.sleep(0.5)
    return win

def find_doc(win):
    doc = None
    def walk(el, depth=0):
        nonlocal doc
        if doc is not None or depth > 15:
            return
        try:
            if el.ControlTypeName == "DocumentControl" and "DeepSeek Harness" in (el.Name or ""):
                doc = el
                return
            for ch in el.GetChildren():
                walk(ch, depth + 1)
        except Exception:
            pass
    walk(win)
    return doc

def find_ctrl(el, ctype, namepart, depth=0, maxd=70):
    if depth > maxd:
        return None
    try:
        if el.ControlTypeName == ctype and namepart.lower() in (el.Name or "").lower():
            return el
        for ch in el.GetChildren():
            r = find_ctrl(ch, ctype, namepart, depth + 1, maxd)
            if r is not None:
                return r
    except Exception:
        pass
    return None

def text_of(el):
    out = []
    def walk(node, depth=0):
        if depth > 40:
            return
        try:
            nm = (node.Name or "").strip()
            if nm:
                out.append(nm)
            for ch in node.GetChildren():
                walk(ch, depth + 1)
        except Exception:
            pass
    walk(el)
    return " | ".join(dict.fromkeys(out))

if __name__ == "__main__":
    win = connect()
    doc = find_doc(win)
    if doc is None:
        print("no DSH doc")
        sys.exit(3)
    pill = find_ctrl(doc, "ButtonControl", "Deep Research")
    print("pill:", pill.Name if pill else None)
    sessions = find_ctrl(win, "TreeControl", "Sessions")
    if sessions is not None:
        print("--- sessions ---")
        print(text_of(sessions)[:900])
