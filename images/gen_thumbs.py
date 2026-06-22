from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.dirname(os.path.abspath(__file__))
W, H = 600, 200

FONT_PATH = r"C:\Windows\Fonts\malgun.ttf"
def font(size):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except:
        return ImageFont.load_default()

def rounded_rect(draw, xy, radius, fill):
    x0,y0,x1,y1 = xy
    draw.rounded_rectangle([x0,y0,x1,y1], radius=radius, fill=fill)

# ── 1. thumb_app.png ─────────────────────────────────────────────────
img = Image.new("RGB", (W,H), "#F0F4F2")
d = ImageDraw.Draw(img)

# 헤더
d.rectangle([0,0,W,34], fill="#0D1B2A")
d.text((12,8), "업무일지", font=font(15), fill="white")

# 통계 카드 4개
cards = [("총원","163","#1a1a2e"),("신규","4","#0B7B6B"),("복관","0","#555"),("휴·퇴관","4","#B71C1C")]
cw = 128
for i,(lbl,val,col) in enumerate(cards):
    x = 8 + i*(cw+5)
    rounded_rect(d,[x,42,x+cw,80], 6, "white")
    d.text((x+8,46), lbl, font=font(10), fill="#888")
    d.text((x+8,58), val, font=font(14), fill=col)

# 섹션 카드 3개
sec = [("특이사항","#B71C1C"),("회의 내용","#0D1B2A"),("교육 내용","#0B7B6B")]
sw = 182
for i,(lbl,col) in enumerate(sec):
    x = 8 + i*(sw+5)
    rounded_rect(d,[x,88,x+sw,188], 6, "white")
    d.rectangle([x,88,x+sw,104], fill=col)
    d.text((x+8,90), lbl, font=font(10), fill="white")
    for j in range(3):
        y = 112 + j*22
        d.rounded_rectangle([x+8,y,x+sw-8,y+10], radius=3, fill="#E8ECF0")

img.save(os.path.join(OUT,"thumb_app.png"))
print("thumb_app.png 완료")

# ── 2. thumb_exam.png ────────────────────────────────────────────────
img = Image.new("RGB", (W,H), "#F0F4F2")
d = ImageDraw.Draw(img)

d.rectangle([0,0,W,34], fill="#0D1B2A")
d.text((12,8), "승급심사 관리", font=font(15), fill="white")

stats = [("전체","161"),("유급자","48"),("1품단","34"),("2품단","42")]
cw2 = 130
for i,(lbl,val) in enumerate(stats):
    x = 8 + i*(cw2+4)
    rounded_rect(d,[x,42,x+cw2,80], 6, "white")
    d.text((x+8,46), lbl, font=font(10), fill="#888")
    d.text((x+8,58), val, font=font(14), fill="#0B7B6B")

names = ["홍길동","김민준","이서윤","박지호"]
grades = ["1단","2단","3품","4품"]
pw = 132
for i,(nm,gr) in enumerate(zip(names,grades)):
    x = 8 + i*(pw+5)
    rounded_rect(d,[x,88,x+pw,188], 6, "white")
    d.text((x+8,96), nm, font=font(12), fill="#1a1a2e")
    rounded_rect(d,[x+8,116,x+pw-8,136], 4, "#1a1a2e")
    tw = d.textlength(gr, font=font(10))
    d.text((x+8+(pw-16-tw)//2, 120), gr, font=font(10), fill="white")
    for j in range(2):
        d.rounded_rectangle([x+8,144+j*20,x+pw-8,154+j*20], radius=3, fill="#E8ECF0")

img.save(os.path.join(OUT,"thumb_exam.png"))
print("thumb_exam.png 완료")

# ── 3. thumb_jumprope.png ────────────────────────────────────────────
img = Image.new("RGB", (W,H), "#F0F4F2")
d = ImageDraw.Draw(img)

d.rectangle([0,0,W,34], fill="#0D1B2A")
d.text((12,8), "줄넘기 급수평가", font=font(15), fill="white")

tabs = ["학생관리","평가","현황","급수증","급수표"]
tx = 8
for t in tabs:
    tw = d.textlength(t, font=font(10)) + 14
    active = t == "평가"
    rounded_rect(d,[tx,38,tx+tw,56], 5, "#0B7B6B" if active else "#E0E0E0")
    d.text((tx+7,41), t, font=font(10), fill="white" if active else "#555")
    tx += tw + 4

# 테이블 헤더
cols = ["이름","학년","현재급수","도전급수"]
cxs = [8,100,200,340]
cws = [80,90,130,240]
d.rectangle([0,60,W,76], fill="#E8ECF0")
for lbl,cx in zip(cols,cxs):
    d.text((cx+4,63), lbl, font=font(9), fill="#666")

rows = [("홍길동","2학년","10급","9급"),("김민준","2학년","9급","8급"),
        ("이서윤","3학년","8급","7급"),("박지호","1학년","7급","6급")]
for ri,(nm,gr,cur,nxt) in enumerate(rows):
    y = 80 + ri*28
    fill = "#FAFAFA" if ri%2==0 else "white"
    d.rectangle([0,y,W,y+26], fill=fill)
    d.text((cxs[0]+4,y+7), nm, font=font(11), fill="#1a1a2e")
    d.text((cxs[1]+4,y+7), gr, font=font(10), fill="#555")
    rounded_rect(d,[cxs[2]+4,y+5,cxs[2]+50,y+21], 4, "#888")
    d.text((cxs[2]+8,y+8), cur, font=font(9), fill="white")
    rounded_rect(d,[cxs[3]+4,y+5,cxs[3]+50,y+21], 4, "#0B7B6B")
    d.text((cxs[3]+8,y+8), nxt, font=font(9), fill="white")

img.save(os.path.join(OUT,"thumb_jumprope.png"))
print("thumb_jumprope.png 완료")

# ── 4. thumb_slowmo.png ──────────────────────────────────────────────
img = Image.new("RGB", (W,H), "#0D1117")
d = ImageDraw.Draw(img)

grid_w = 420
cell_w = grid_w // 4
cell_h = H // 2
colors = ["#FF3B30","#FF9500","#FFD60A","#30D158","#0A84FF","#BF5AF2","#FF2D55","#64D2FF"]

for row in range(2):
    for col in range(4):
        idx = row*4+col
        x0 = col*cell_w + 2
        y0 = row*cell_h + 2
        x1 = x0+cell_w-4
        y1 = y0+cell_h-4
        d.rounded_rectangle([x0,y0,x1,y1], radius=5, outline=colors[idx], width=2, fill="#161B22")
        num = str(idx+1)
        nw = d.textlength(num, font=font(18))
        d.text((x0+(cell_w-nw)//2, y0+12), num, font=font(18), fill=colors[idx])
        iw = d.textlength("IDLE", font=font(8))
        d.text((x0+(cell_w-iw)//2, y0+cell_h-22), "IDLE", font=font(8), fill="#888")

# 우측 패널
px = grid_w + 4
d.rectangle([px,0,W,H], fill="#161B22")
d.text((px+8,10), "슬로우모션", font=font(11), fill="white")

speed_btns = [("0.25x","#444"),("0.5x","#444"),("0.33x","#444")]
for si,(lbl,bc) in enumerate(speed_btns):
    by = 36+si*26
    rounded_rect(d,[px+6,by,W-6,by+20], 4, bc)
    bw = d.textlength(lbl, font=font(9))
    d.text((px+6+(W-px-12-bw)//2, by+5), lbl, font=font(9), fill="white")

rounded_rect(d,[px+6,120,W-6,148], 6, "#BF5AF2")
sw2 = d.textlength("START", font=font(11))
d.text((px+6+(W-px-12-sw2)//2, 127), "START", font=font(11), fill="white")

img.save(os.path.join(OUT,"thumb_slowmo.png"))
print("thumb_slowmo.png 완료")
print("전체 완료!")
