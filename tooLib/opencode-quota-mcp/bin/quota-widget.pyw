# -*- coding: utf-8 -*-
"""
quota-widget.pyw — opencode Go 剩余额度桌面浮窗
（KalciriteUI v4「Folio」设计语言 · folio-graphite 主题）

启动（无控制台黑窗）:
    C:\\CondaPython\\Conda\\pythonw.exe "E:\\KalciriteTools\\tooLib\\opencode-quota-mcp\\bin\\quota-widget.pyw"

交互:
    单击     = 收起 / 展开（完整面板 ↔ 一行迷你条）
    拖动     = 移动浮窗（位置自动记忆）
    双击     = 立即刷新
    右键     = 菜单（立即刷新 / 收起或展开 / 退出）
    自动     = 每 REFRESH_MS 刷新一次；查询失败时 ERROR_RETRY_SEC 秒后重试
    收起状态与位置一并记忆，重启后保持。

显示口径（浮窗上两段数字分开标注，归属不同；一律用「已用百分比」，
    不用美元——美元换算不直观也不准确）:
    「共享池」= console 接口的账户级 meters
    （已用$/$限额$ 折算成已用%，5 小时/本周/本月三段），即所有人用量的总和；
    console 失败或无数据时该段显示 —；
    多 key 时取第一把 key 所在账户的池子。
    「本 key 自用」条形 = usage 接口这把 key 自己订阅的三窗口
    已用% = percent（官方 percent 本身就是已用%，CLI 表头同此口径），只算这一把 key。
    两段同口径、上下并排，可逐窗口对比「自己 vs 所有人总和」；
    某窗口 rate-limited（用满）时该条画满红色并标「限流」。
    另: 官方控制台还有「按模型限额」口径——每个模型有独立月度美元
    限额（例: DeepSeek V4.1 Flash，Go 档 $100/月），与上面两套口径
    并存、数量级不同。
    限额可能调整，以官方文档为准: https://opencode.ai/docs/console/go/

数据源: 子进程调用同目录 CLI --json（输出自带 key 掩码）。
        本浮窗不读取、不显示原始 key，无新增密钥暴露面。
视觉:   KalciriteUI v4「Folio: Calm Minimal」· folio-graphite 主题令牌
        （画布 bg-0 #16181b / 卡片 bg-1 #1c1f23 / 轨道 bg-2 #24282d、
        fg #eceef1、muted #9aa1aa、faint #979ca4、hairline #2b3036、
        主颜料琥珀 #d9a441、次颜料钢蓝 #6f9dd1、语义色绿/黄/红）。
        组件: 条形对齐 .hln-v4-bar（track 6px / radius-pill / bg-2），
        卡片 6px 圆角（--hln-ui-radius-md），面板外框 8px（--hln-ui-radius-lg）。
        配色分工: 条形穿「它所度量的东西的色」——共享池段主颜料琥珀、
        本 key 段次颜料钢蓝；严重度（绿/黄/红）由右侧读数承担。
        表情: 14×11 矢量画框（不用 ASCII 字符脸——'^_^' 在微软雅黑里会渲染
        成「两撇 + 一条孤立短横」），展开/收起两态同尺寸同位置。
        栅格: 表情 x=16（落在面板左侧留白）、标题 x=44、数字右对齐 x=226、
        切换箭头 x=237；
        展开/收起两态共用同一条内容轨、同宽（248）、同圆角、同底色，
        收起态 = 同一个面板只留顶排（身体隐藏）。
        顶部固定: 顶排基线 HEADER_CY=17，收起/展开时顶端那一排像素级不动。
        窗体不透明（alpha=1）——半透明会让背后文字透进卡片，显脏。
        字体: 数值用 display（Bahnschrift SemiBold）、key 掩码用 technical
        （Cascadia Code）、中文正文用 body（Microsoft YaHei UI）。
        令牌来源: apps/agent-workbench/src/renderer/vendor/hln-ui-system-v4.css
调参:   改 CONFIG 区常量即可（刷新间隔 / 颜色阈值 / 尺寸 / 透明度）。
"""

import json
import math
import os
import queue
import subprocess
import threading
import time
import tkinter as tk

# ════════════════ CONFIG ════════════════════════════════════════
NODE_PATH       = r"E:\dependency-cache\node-runtime\node.exe"   # 缺失时回退 PATH 上的 node
CLI_PATH        = r"E:\KalciriteTools\tooLib\opencode-quota-mcp\bin\opencode-go-quota.mjs"
REFRESH_MS      = 10 * 60 * 1000   # 自动刷新间隔（毫秒），默认 10 分钟
ERROR_RETRY_SEC = 60               # 查询失败后重试间隔（秒）
CLI_TIMEOUT_SEC = 30               # 单次 CLI 查询超时（秒）
WIN_W           = 248              # 浮窗宽度（像素）
ALPHA           = 1.0              # 窗体透明度 0~1（半透明会让背后文字透出来）
GREEN_GT        = 50               # 已用 < 50% → 绿
YELLOW_GT       = 80               # 已用 < 80% → 黄，否则红
FONT      = "Microsoft YaHei UI"     # --hln-ui-font-cjk-hei（中文正文）
FONT_NUM  = "Bahnschrift SemiBold"   # --hln-ui-font-display（层级与数值）
FONT_MONO = "Cascadia Code"          # --hln-ui-font-technical（ID / 读数）
# ── 版式（v4 4/6/8px 几何 + 组件规格）──
HEAD_H          = 40               # 头部高度
COLLAPSED_H     = 34               # 收起态（迷你条）高度
PANEL_R         = 8                # --hln-ui-radius-lg 面板外框圆角
FACE_W, FACE_H = 16, 12           # 表情矢量画框（展开/收起两态同尺寸同位置）
FACE_X          = 16               # 表情左边界：落在面板左侧留白里，比内容轨更靠左
HEADER_CY      = 17               # 顶部那一排的基线：两态共用，收起/展开时顶端不跳
CARD_X0, CARD_X1 = 8, 240          # 卡片左右边界
CONTENT_L, CONTENT_R = 22, 226     # 卡片内文字左右边界（数字右对齐列）
CARD_TITLE_H    = 20               # 卡片标题行高
CARD_PAD_B      = 10               # 卡片底部留白
ROW_H           = 17               # 数据行高
BAR_H           = 6                # .hln-v4-bar__track 高度 6px
CARD_R          = 6                # --hln-ui-radius-md 卡片圆角
X0, BAR_W       = 68, 110          # 条形起点与长度
KEY_HEAD_H      = 19               # 每把 key 的标题行高
KEY_GAP         = 10               # 多 key 之间的间隔
SECTION_GAP     = 10               # 两张卡片之间的间隔
# ════════════════════════════════════════════════════════════════════════

# ── KalciriteUI v4 · folio-graphite 令牌（引擎原值，不自造色板）─────
# 引擎源: apps/agent-workbench/src/renderer/vendor/hln-ui-system-v4.css
BG      = "#16181b"   # --hln-ui-bg-0       画布
CARD    = "#1c1f23"   # --hln-ui-bg-1       卡片 / 面板
CARD_BD = "#2b3036"   # --hln-ui-line       发丝线 / 描边
FG      = "#eceef1"   # --hln-ui-text       主文字
MUTED   = "#9aa1aa"   # --hln-ui-text-muted 次级文字
FAINT   = "#979ca4"   # --hln-ui-text-faint 极弱文字（标签 / 提示）
ACCENT  = "#d9a441"   # --hln-ui-accent      主颜料（共享池段）
ACCENT2 = "#6f9dd1"   # --hln-ui-accent-cool 次颜料（本 key 段）
GREEN   = "#66a67c"   # --hln-ui-success
YELLOW  = "#c9973f"   # --hln-ui-warning
RED     = "#d68179"   # --hln-ui-danger
BAR_BG  = "#24282d"   # --hln-ui-bg-2       .hln-v4-bar__track 轨道底

WINDOWS   = (("rolling", "5 小时"), ("weekly", "本周"), ("monthly", "本月"))
METER_KEYS = (("fiveHour", "5 小时"), ("week", "本周"), ("month", "本月"))

POS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "quota-widget.pos.json")


def fetch_quota():
    """子进程跑 CLI --json；任何失败都折算成 {ok:False, error:...}。"""
    node = NODE_PATH if os.path.isfile(NODE_PATH) else "node"
    try:
        proc = subprocess.run(
            [node, CLI_PATH, "--json", "--console"],
            capture_output=True, timeout=CLI_TIMEOUT_SEC,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except FileNotFoundError:
        return {"ok": False, "error": "未找到 node.exe"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "查询超时（>%ds）" % CLI_TIMEOUT_SEC}
    except OSError as e:
        return {"ok": False, "error": "启动查询进程失败: %s" % e}
    try:
        return json.loads(proc.stdout.decode("utf-8", "replace"))
    except ValueError:
        return {"ok": False, "error": "CLI 输出非 JSON（退出码 %s）" % proc.returncode}


def load_state():
    """读取上次的位置与收起状态；失败返回空 dict。"""
    try:
        with open(POS_FILE, "r", encoding="utf-8") as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {}
    except Exception:
        return {}


def save_state(x, y, collapsed):
    try:
        with open(POS_FILE, "w", encoding="utf-8") as f:
            json.dump({"x": int(x), "y": int(y), "collapsed": bool(collapsed)}, f)
    except Exception:
        pass


class QuotaWidget:
    def __init__(self, root):
        self.root = root
        self.canvas = tk.Canvas(root, width=WIN_W, height=HEAD_H, bg=BG,
                                highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)
        self.q = queue.Queue()
        self.data = None          # 最近一次含 results 的 JSON
        self.err = None           # 最近一次错误文本
        self.busy = False
        self.next_at = 0.0        # 下次自动刷新 epoch 秒

        st = load_state()
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        if "x" in st and "y" in st:
            self.pos = (int(st["x"]), int(st["y"]))
        else:                                               # 首次: 屏幕右下角
            self.pos = (sw - WIN_W - 16, sh - 260)
        self.pos = (max(0, min(self.pos[0], sw - 80)),
                    max(0, min(self.pos[1], sh - 60)))
        self.collapsed = bool(st.get("collapsed"))

        self._wx = self._wy = 0   # 拖动锚点偏移
        self._x0 = self._y0 = 0   # 按下点
        self._dragging = False   # 拖动中
        self._pending = None     # 待执行的「单击收起」定时器
        self._last_double = 0.0  # 上次双击时间（用于抑制双击后的单击）

        menu = tk.Menu(root, tearoff=0, bg=CARD, fg=FG,
                       activebackground=CARD_BD, activeforeground=FG,
                       font=(FONT, 9))
        menu.add_command(label="立即刷新（也可双击）", command=self.refresh)
        menu.add_command(label="收起 / 展开（也可单击）", command=self.toggle_collapsed)
        menu.add_separator()
        menu.add_command(label="退出", command=self.quit)
        self.menu = menu

        c = self.canvas
        c.bind("<Button-1>", self.on_down)
        c.bind("<B1-Motion>", self.on_move)
        c.bind("<ButtonRelease-1>", self.on_drop)
        c.bind("<Double-Button-1>", self.on_double)
        c.bind("<Button-3>", self.on_menu)

        root.overrideredirect(True)
        root.attributes("-topmost", True)
        root.attributes("-alpha", ALPHA)
        self.render()
        self.refresh()
        root.after(400, self.loop)

    # ── 数据 ──
    def refresh(self):
        if self.busy:
            return
        self.busy = True
        self.err = None
        self.render()
        threading.Thread(target=lambda: self.q.put(fetch_quota()),
                         daemon=True).start()

    def accept(self, data):
        """应用一次查询结果；失败时保留旧数据、底部提示，稍后重试。"""
        self.busy = False
        results = data.get("results") if isinstance(data, dict) else None
        if isinstance(data, dict) and data.get("ok"):
            self.data, self.err = data, None
            self.next_at = time.time() + REFRESH_MS / 1000.0
        elif isinstance(results, list) and results:
            # 多 key 模式：部分失败仍有可显示的结果行
            self.data, self.err = data, "部分 key 查询失败（退出码 2）"
            self.next_at = time.time() + REFRESH_MS / 1000.0
        else:
            msg = data.get("error") if isinstance(data, dict) else None
            self.err = msg or "查询失败"
            self.next_at = time.time() + ERROR_RETRY_SEC
        self.render()

    # ── 渲染 ──
    def remaining_pct(self, w):
        """窗口剩余百分比 = 100 - 已用%（官方 percent 本身即已用%）；限流→0.0。"""
        if not w:
            return None
        if w.get("rateLimited"):
            return 0.0
        p = w.get("percent")
        if w.get("status") != "ok" or not isinstance(p, (int, float)):
            return None
        return max(0.0, min(100.0, 100.0 - float(p)))

    def min_left(self):
        lefts, any_rated = [], False
        for r in (self.data or {}).get("results", []):
            if not r.get("ok"):
                continue
            wins = r.get("windows") or {}
            for key, _tag in WINDOWS:
                w = wins.get(key)
                if not w:
                    continue
                if w.get("rateLimited"):
                    any_rated = True
                    continue
                v = self.remaining_pct(w)
                if v is not None:
                    lefts.append(v)
        return (min(lefts) if lefts else None), any_rated

    def face_state(self):
        """表情状态（供矢量绘制用）。语义与旧字符脸一一对应：
        busy=-.- / error=?_? / limited=x_x / neutral=-_- /
        calm=^o^ / happy=^_^ / worried=>_< / sad=T_T"""
        if self.busy:
            return "busy"
        if self.err and not self.data:
            return "error"
        left, any_rated = self.min_left()
        if any_rated:
            return "limited"
        if left is None:
            return "neutral"
        if left >= 95:
            return "calm"
        if left > GREEN_GT:
            return "happy"
        if left > YELLOW_GT:
            return "neutral"
        if left > 10:
            return "worried"
        return "sad"

    def draw_face(self, x, y, state):
        """矢量表情：固定 14×11 画框（x,y 为左上角），两态完全对齐。

        为什么不用 '^_^' 这类字符脸：微软雅黑里 '^' 浮在字高上部、'_' 掉到
        基线，渲染出来是「两撇 + 一条孤立短横」，看着像画崩了。矢量笔画
        才能让眼与嘴落在固定基线上。
        """
        c = self.canvas
        eye_c = RED if state in ("limited", "error") else FG
        mouth_c = MUTED
        lw = 1.3

        def line(x1, y1, x2, y2, color=eye_c):
            c.create_line(x1, y1, x2, y2, fill=color, width=lw,
                          capstyle="round")

        def chevron_up(ex, ey):
            line(ex, ey + 4, ex + 2.5, ey)
            line(ex + 2.5, ey, ex + 5, ey + 4)

        def chevron_in(ex, ey):
            line(ex, ey, ex + 5, ey + 2.5)
            line(ex + 5, ey + 2.5, ex, ey + 5)

        def dash(ex, ey):
            line(ex, ey + 2.5, ex + 5, ey + 2.5)

        def cross(ex, ey):
            line(ex, ey, ex + 5, ey + 5)
            line(ex, ey + 5, ex + 5, ey)

        def dot(ex, ey):
            c.create_oval(ex + 1.5, ey + 1.5, ex + 3.5, ey + 3.5, fill=eye_c,
                          outline="")

        eye_y = y + 1
        for ex in (x + 1, x + 11):
            if state in ("happy", "calm"):
                chevron_up(ex, eye_y)
            elif state == "worried":
                chevron_in(ex, eye_y)
            elif state == "limited":
                cross(ex, eye_y)
            elif state == "error":
                dot(ex, eye_y)
            else:                                   # neutral / busy / sad
                dash(ex, eye_y)

        my = y + 9
        if state == "calm":                       # 小圆嘴
            c.create_oval(x + 6, my - 1, x + 10, my + 3, outline=mouth_c,
                          width=lw)
        elif state == "happy":                   # 浅微笑
            line(x + 4, my - 1, x + 8, my + 1, mouth_c)
            line(x + 8, my + 1, x + 12, my - 1, mouth_c)
        elif state == "sad":                     # 皱眉
            line(x + 4, my + 1, x + 8, my - 1, mouth_c)
            line(x + 8, my - 1, x + 12, my + 1, mouth_c)
        else:                                    # 平嘴
            line(x + 5, my, x + 11, my, mouth_c)

    def color_used(self, used):
        """已用百分比配色：<50 绿，<80 黄，否则红。"""
        if used < GREEN_GT:
            return GREEN
        if used < YELLOW_GT:
            return YELLOW
        return RED

    def pool_used(self, w):
        """console meters → 已用%（used/limit 折算，clamp 0..100）。"""
        if (isinstance(w, dict) and w.get("limit")
                and isinstance(w.get("used"), (int, float))
                and isinstance(w.get("limit"), (int, float))):
            return max(0.0, min(100.0, 100.0 * w["used"] / w["limit"]))
        return None

    def key_used(self, w):
        """usage 窗口 → 已用%（官方 percent 本身即已用%，直接取用）。"""
        if not w:
            return None
        if w.get("rateLimited"):
            return 100.0
        p = w.get("percent")
        if w.get("status") != "ok" or not isinstance(p, (int, float)):
            return None
        return max(0.0, min(100.0, float(p)))

    # ── v4 几何：圆角矩形（radius-md 6px / radius-pill 胶囊）──
    def rrect(self, x, y, w, h, r, fill=None, outline=None):
        """用 polygon 画圆角矩形：tkinter 的 rectangle 没有圆角。
        顶点按顺时针生成（屏幕坐标 y 向下），每角 8 段弧采样。"""
        r = max(0.0, min(r, w / 2.0, h / 2.0))
        if r <= 0:
            pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
        else:
            pts = []

            def arc(cx, cy, a0, a1, n=8):
                for i in range(n + 1):
                    a = math.radians(a0 + (a1 - a0) * i / float(n))
                    pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))

            arc(x + r, y + r, 180, 270)          # 左上
            arc(x + w - r, y + r, 270, 360)      # 右上
            arc(x + w - r, y + h - r, 0, 90)     # 右下
            arc(x + r, y + h - r, 90, 180)       # 左下
        self.canvas.create_polygon(pts, fill=fill or "", outline=outline or "")

    def draw_chevron(self, x_right, cy, down=False):
        """面板右侧的切换箭头（矢量，不依赖字体符号）。
        down=False → 展开态的「›」；down=True → 展开后的「⌄」。"""
        c = self.canvas
        lw = 1.2
        if down:
            c.create_line(x_right - 5, cy - 2, x_right - 2, cy + 2,
                          fill=FAINT, width=lw, capstyle="round")
            c.create_line(x_right - 2, cy + 2, x_right + 1, cy - 2,
                          fill=FAINT, width=lw, capstyle="round")
        else:
            c.create_line(x_right - 4, cy - 3, x_right, cy,
                          fill=FAINT, width=lw, capstyle="round")
            c.create_line(x_right, cy, x_right - 4, cy + 3,
                          fill=FAINT, width=lw, capstyle="round")

    # ── 收起态：一行迷你条 ──
    def collapse_value(self):
        """迷你条上显示的数值：所有 key 窗口里最高的已用%及其窗口名。"""
        best, tag, rated = None, "", False
        for r in (self.data or {}).get("results", []):
            if not r.get("ok"):
                continue
            wins = r.get("windows") or {}
            for key, name in WINDOWS:
                w = wins.get(key)
                if not w:
                    continue
                if w.get("rateLimited"):
                    rated = True
                    continue
                u = self.key_used(w)
                if u is not None and (best is None or u > best):
                    best, tag = u, name
        if best is None:
            meters = self.pick_meters()
            for mkey, name in METER_KEYS:
                u = self.pool_used((meters or {}).get(mkey))
                if u is not None and (best is None or u > best):
                    best, tag = u, name
        return best, tag, rated

    def render_collapsed(self):
        """迷你条 = 同一个面板的顶排（身体隐藏），因此与展开态：
        同宽（WIN_W）、同圆角（PANEL_R）、同底色（BG）、同栅格、同基线。

        列位: 表情 x=22 · 标题 x=44 · 窗口名右对齐 x=196 · 数值右对齐 x=226 ·
              切换箭头 x=237（都在同一条内容轨上）。
        """
        c = self.canvas
        h, w = COLLAPSED_H, WIN_W
        c.configure(width=w, height=h)
        self.root.geometry("%dx%d+%d+%d" % (w, h, self.pos[0], self.pos[1]))
        self.rrect(1, 1, w - 2, h - 2, PANEL_R, fill=BG, outline=CARD_BD)
        cy = HEADER_CY
        self.draw_face(FACE_X, cy - FACE_H / 2.0, self.face_state())
        c.create_text(44, cy, text="opencode Go", font=(FONT_NUM, 10),
                      fill=FG, anchor="w")
        used, tag, rated = self.collapse_value()
        if rated:
            c.create_text(226, cy, text="限流", font=(FONT, 9, "bold"),
                          fill=RED, anchor="e")
        elif used is None:
            c.create_text(226, cy, text="—", font=(FONT_NUM, 10),
                          fill=MUTED, anchor="e")
        else:
            c.create_text(196, cy, text=tag, font=(FONT, 8), fill=MUTED,
                          anchor="e")
            c.create_text(226, cy, text="%d%%" % round(used),
                          font=(FONT_NUM, 10), fill=self.color_used(used),
                          anchor="e")
        self.draw_chevron(237, cy, down=False)

    # ── 展开态：完整面板 ──
    def render(self):
        c = self.canvas
        c.delete("all")
        if self.collapsed:
            self.render_collapsed()
            return

        results = (self.data or {}).get("results") or []
        meters = self.pick_meters()

        if not results:
            h = HEAD_H + 74
            sec1 = sec2 = 0
        else:
            sec1 = CARD_TITLE_H + 3 * ROW_H + CARD_PAD_B
            sec2 = (CARD_TITLE_H + len(results) * (KEY_HEAD_H + 3 * ROW_H)
                    + max(0, len(results) - 1) * KEY_GAP + CARD_PAD_B)
            h = (HEAD_H + SECTION_GAP + sec1 + SECTION_GAP + sec2
                 + (20 if self.err else 0) + 10)

        c.configure(width=WIN_W, height=h)
        self.root.geometry("%dx%d+%d+%d" % (WIN_W, h, self.pos[0], self.pos[1]))
        self.rrect(1, 1, WIN_W - 2, h - 2, PANEL_R, fill=BG, outline=CARD_BD)

        # ── 头部：表情 + 标题居左，状态居右（与卡片内容同栅格；
        #    基线用 HEADER_CY，与收起态迷你条完全一致——切换时顶端不跳）
        self.draw_face(FACE_X, HEADER_CY - FACE_H / 2.0, self.face_state())
        c.create_text(44, HEADER_CY, text="opencode Go",
                      font=(FONT_NUM, 10), fill=FG, anchor="w")
        if self.busy:
            sub = "查询中…"
        elif results:
            sub = "%d 把 key" % len(results)
        else:
            sub = "未获取数据"
        c.create_text(CONTENT_R, HEADER_CY, text=sub, font=(FONT, 8),
                      fill=MUTED, anchor="e")
        self.draw_chevron(237, HEADER_CY, down=True)
        c.create_line(CARD_X0, 31, CARD_X1, 31, fill=CARD_BD)

        if not results:
            self.rrect(CARD_X0, HEAD_H, CARD_X1 - CARD_X0, h - 12 - HEAD_H,
                       CARD_R, fill=CARD, outline=CARD_BD)
            c.create_text(WIN_W / 2, HEAD_H + 30, text=self.err or "…",
                          font=(FONT, 8), fill=MUTED, anchor="center",
                          width=WIN_W - 2 * CARD_X0 - 24)
            return

        # ── 第一张卡：共享池（账户级总额度池，所有人用量的总和）
        y = HEAD_H + SECTION_GAP
        self.rrect(CARD_X0, y, CARD_X1 - CARD_X0, sec1, CARD_R,
                   fill=CARD, outline=CARD_BD)
        c.create_text(CONTENT_L, y + 12, text="共享池", font=(FONT, 8, "bold"),
                      fill=ACCENT, anchor="w")
        c.create_text(CONTENT_R, y + 12, text="所有 key 合计", font=(FONT, 8),
                      fill=MUTED, anchor="e")
        ry = y + CARD_TITLE_H
        for mkey, tag in METER_KEYS:
            self.bar(ry, tag, self.pool_used((meters or {}).get(mkey)), "pool")
            ry += ROW_H

        # ── 第二张卡：每把 key 自己的订阅用量
        y += sec1 + SECTION_GAP
        self.rrect(CARD_X0, y, CARD_X1 - CARD_X0, sec2, CARD_R,
                   fill=CARD, outline=CARD_BD)
        label = "本 key 自用" if len(results) == 1 else "各 key 自用"
        c.create_text(CONTENT_L, y + 12, text=label, font=(FONT, 8, "bold"),
                      fill=ACCENT2, anchor="w")
        c.create_text(CONTENT_R, y + 12, text="订阅三窗口", font=(FONT, 8),
                      fill=MUTED, anchor="e")
        ry = y + CARD_TITLE_H
        for i, r in enumerate(results):
            mask = (r.get("label") or r.get("keyMask") or "key")[:20]
            ok = bool(r.get("ok"))
            cy = ry + KEY_HEAD_H / 2.0
            c.create_oval(CONTENT_L + 0.5, cy - 2.5, CONTENT_L + 5.5, cy + 2.5,
                          fill=(GREEN if ok else RED), outline="")
            c.create_text(CONTENT_L + 13, cy, text=mask, font=(FONT_MONO, 8),
                          fill=(FG if ok else RED), anchor="w")
            ry += KEY_HEAD_H
            wins = r.get("windows") or {}
            for key, tag in WINDOWS:
                self.bar(ry, tag, self.key_used(wins.get(key)), "key")
                ry += ROW_H
            if i < len(results) - 1:
                ry += KEY_GAP

        if self.err and results:
            c.create_text(CONTENT_L, y + sec2 + 12, text="⚠ " + self.err,
                          font=(FONT, 8), fill=RED, anchor="w",
                          width=WIN_W - 2 * CARD_X0 - 24)

    def bar(self, y, tag, used, kind):
        """一行：窗口名 + 胶囊轨道 + 右对齐的已用%。used=None 表示缺数据。

        组件规格对齐 v4 .hln-v4-bar：track 6px / radius-pill / bg-2 轨道。
        配色分工：条形「穿它所度量的东西的色」——共享池段主颜料琥珀、
        本 key 段次颜料钢蓝；严重度（绿/黄/红）由右侧读数承担。
        """
        c = self.canvas
        cy = y + ROW_H / 2.0
        c.create_text(CONTENT_L, cy, text=tag, font=(FONT, 8), fill=FAINT,
                      anchor="w")
        by = cy - BAR_H / 2.0
        self.rrect(X0, by, BAR_W, BAR_H, BAR_H / 2.0, fill=BAR_BG)
        tone = ACCENT if kind == "pool" else ACCENT2
        if used is None:
            c.create_text(CONTENT_R, cy, text="—", font=(FONT_NUM, 9),
                          fill=MUTED, anchor="e")
            return
        if kind == "key" and used >= 100.0:
            self.rrect(X0, by, BAR_W, BAR_H, BAR_H / 2.0, fill=RED)
            c.create_text(CONTENT_R, cy, text="限流", font=(FONT, 8, "bold"),
                          fill=RED, anchor="e")
            return
        fill_w = BAR_W * used / 100.0
        if fill_w >= 1:
            self.rrect(X0, by, fill_w, BAR_H, BAR_H / 2.0, fill=tone)
        c.create_text(CONTENT_R, cy, text="%d%%" % round(used),
                      font=(FONT_NUM, 9), fill=self.color_used(used), anchor="e")

    def pick_meters(self):
        """账户级 meters（所有人用量的总和）：取第一个带 console.meters 的
        result；缺失时返回 None，对应段显示 —。"""
        for r in (self.data or {}).get("results") or []:
            cons = r.get("console")
            m = cons.get("meters") if isinstance(cons, dict) else None
            if isinstance(m, dict):
                return m
        return None

    # ── 交互 ──
    def on_down(self, e):
        self._dragging = False
        self._x0, self._y0 = e.x_root, e.y_root
        self._wx = self.root.winfo_x() - e.x_root
        self._wy = self.root.winfo_y() - e.y_root

    def on_move(self, e):
        if abs(e.x_root - self._x0) > 3 or abs(e.y_root - self._y0) > 3:
            self._dragging = True
        if self._dragging:
            x, y = e.x_root + self._wx, e.y_root + self._wy
            self.pos = (x, y)
            self.root.geometry("+%d+%d" % (x, y))

    def on_drop(self, e):
        if self._dragging:
            self.save_state()
            return
        if self._last_double and time.time() - self._last_double < 0.4:
            return                      # 刚发生过双击，忽略本次单击
        if self._pending:
            self.root.after_cancel(self._pending)
        self._pending = self.root.after(260, self.toggle_collapsed)

    def on_double(self, e):
        self._last_double = time.time()
        if self._pending:
            self.root.after_cancel(self._pending)
            self._pending = None
        self.refresh()

    def toggle_collapsed(self):
        self._pending = None
        self.collapsed = not self.collapsed
        self.save_state()
        self.render()

    def on_menu(self, e):
        try:
            self.menu.tk_popup(e.x_root, e.y_root)
        finally:
            self.menu.grab_release()

    def save_state(self):
        save_state(self.pos[0], self.pos[1], self.collapsed)

    def quit(self):
        self.save_state()
        self.root.destroy()

    def loop(self):
        try:
            while True:
                self.accept(self.q.get_nowait())
        except queue.Empty:
            pass
        if not self.busy and self.next_at > 0 and time.time() >= self.next_at:
            self.refresh()
        self.root.after(500, self.loop)


def main():
    root = tk.Tk()
    QuotaWidget(root)
    root.mainloop()


if __name__ == "__main__":
    main()
