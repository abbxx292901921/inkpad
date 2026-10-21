# Notability UI reference — notes transcribed from the user's screenshots

Source: 7 iPad screenshots of Notability (captured 21 Oct 2026) + 1 screenshot of
Inkpad for comparison. This file is the **spec** for the Inkpad UI rebuild. It
records what was actually visible in the photos, not what Notability does in
every mode.

Photographs are not in the repo (they are in the conversation). This document
is the durable copy.

---

## 0. Current Inkpad state (photo 1, for comparison)

Our toolbar is a flat, full-width, text-labelled bar pinned to the top:

```
[Pen] [Highlighter] [Eraser] | (o)(blue)(red)(green) | [2][3][5] | [Undo][Redo]
```

Gaps vs Notability:
- text labels instead of icons
- flat bar, not a floating pill
- no expandable tool island
- no colour popover, no stroke popover
- no shapes, no lasso, no transform handles
- no ruler, no rotation dial
- no library / notes / folders screen at all
- no page model (one infinite canvas)

---

## 1. Top bar — collapsed (photos 2, 3)

Two separate floating pills, both with a heavy drop shadow, near the top of the
screen with generous margins.

### 1a. Left pill — round back button
- Circular button, ~44pt, white, shadow, containing a **left chevron** (‹).
- Returns to the library / previous screen.

### 1b. Centre pill — the tool strip
A horizontal row of icon-only buttons, no text labels, no dividers visible in
the collapsed state. Left-to-right, as seen in photo 2:

| # | Icon | Meaning (inferred) | Confidence |
|---|------|--------------------|-----------|
| 1 | hand holding a pen | "Draw" / tools menu | medium |
| 2 | picture with a down-arrow (into a box) | Add image / import | high |
| 3 | pen with a trailing line | "Add stroke" / ink conversion | medium |
| 4 | eraser (tilted rounded rectangle) | Eraser | high |
| 5 | chisel/felt marker, **orange** | Highlighter / marker | high |
| 6 | microphone | Audio recording | high |
| 7 | gear | Settings | high |
| 8 | chevron pointing **right** (>) | Expand the tool island | high |

The chevron is the expansion affordance — tapping it swaps the pill for the
expanded island in §2.

### 1c. Right pill — history + page
| # | Icon | Meaning | Confidence |
|---|------|---------|-----------|
| 1 | undo arrow (curved, left-pointing) | Undo | high |
| 2 | redo arrow (curved, right-pointing, **greyed out**) | Redo (disabled, no history) | high |
| 3 | circle with three dots | More / page options | high |
| 4 | overlapping page sheets | Add page | high |

Visual notes:
- Icons are ~22–24pt, monochrome (dark grey `#4a4a4a`), thin-stroke style.
- Active/selected state = the icon is **blue** (`#0a84ff`), or (in the tool
  island) shown with an **underline** beneath the icon.
- Buttons are icon-only; they must carry `aria-label` + `title` for a11y.
- The pills float ~10pt from the top edge and have a large corner radius
  (~18–22pt) and a soft shadow.

---

## 2. Tool island — expanded (photo 4)

Tapping the `>` chevron expands the pill **downward into two rows**. The pill
grows; it does not become a separate floating panel.

### Row 1 — tool icons
Left-to-right:

| # | Icon | Tool | Selected style |
|---|------|------|----------------|
| 1 | pen nib, tip down-right, **blue** + underline | **Pen** | blue + 2px underline |
| 2 | chisel marker (double-line body) | Marker / highlighter | blue + underline |
| 3 | pencil (pointed, striped body) | Pencil | blue + underline |
| 4 | eraser (tilted rounded rect) | Eraser | blue + underline |
| 5 | "T" glyph made of a bracket + bar + stem | Shapes / Text | blue + underline |
| 6 | **dashed rectangle** in a dotted frame | Select / lasso | blue + underline |
| 7 | circle with a **+** inside | Add element | — |
| 8 | microphone | Audio | — |
| — | **vertical divider** | | |
| 9 | hand with a small pen | Pen settings / "more tools" | — |
| 10 | chevron pointing **right** (>) — collapses back | Collapse | — |

Note: in the collapsed pill the tools are *not* the same icons as the expanded
island (photo 2 shows hand/pen, image, pen-with-line, eraser, marker, mic,
gear; photo 4 shows pen/marker/pencil/eraser/shape/select/+/mic). The collapsed
pill is a **different, reduced set**. Inkpad can get away with one set shown in
both states, but the expanded island is the canonical tool list.

### Row 2 — options strip (context sensitive)
In photo 4 (Pen selected) row 2 contains, left to right:

| Element | Detail |
|---|---|
| Colour swatch row | black (selected, white ring + check), blue, green, red, purple, white |
| `+` button | add a custom colour → opens the colour panel |
| **vertical divider** | |
| two circular buttons | thin stroke (small dot) / thick stroke (large filled dot) — the line-thickness control |

In photo 5 (Shape tool selected) row 2 instead contains a **segmented control**:

| Segment | Meaning |
|---|---|
| `Freeform` (with a cloud-ish outline glyph) | shapes drawn as outlines only |
| `Boxed` (with a dashed rectangle glyph, **selected**, blue tint) | shapes drawn with a filled box |

The segmented control is blue-tinted with a blue border when selected.

---

## 3. Colour panel popover (photos 4, 5)

A floating card, anchored under the colour row, ~380pt wide, white with a large
radius and a strong shadow.

```
┌────────────────────────────────────────┐
│ Colors                          ( 🎨 ) │  ← title row + colour-wheel button (right)
│  ●  ●  ●  ●  ●  ●  ●  ●                 │  ← row 1: 8 colours
│  ●  ●  ●  ●  ○  ●  ✓  ●                │  ← row 2: 8 colours (one selected)
│        ●  ●  ●  ●                       │  ← palette page dots (5 dots, 1 filled)
└────────────────────────────────────────┘
```

- **Title**: "Colors" (US spelling), bold, dark, left-aligned.
- **Colour wheel button**: top-right, a small circular rainbow wheel → opens a
  full HSV picker.
- **Grid**: 2 rows × 8 columns of round swatches.
- **Selected swatch**: black fill with a **white checkmark** drawn on it (not
  just a ring). White swatch is drawn as an outlined circle (white on white).
- **Palette pages**: a row of small dots beneath the grid — 5 dots, the first
  filled dark, the rest grey. Tapping a dot switches to another colour palette.
  (Multiple palettes are a Notability feature worth copying: users keep a
  separate set of colours per subject.)

### Observed palette (row 1 → row 2)
1. yellow `#ffd60a`
2. orange `#ff9f0a`
3. red `#ff3b30`
4. pink / magenta `#ff2d95`
5. lime `#a3e635`-ish (bright yellow-green)
6. green `#34c759`
7. purple `#af52de`
8. deep purple `#5e5ce6`
9. dark green `#1f7a3d`
10. blue `#0a84ff`
11. dark blue `#0b4fa8`
12. very dark navy / indigo `#1c1c4e`
13. white `#ffffff` (outlined)
14. grey `#8e8e93`
15. black `#000000` (selected, checkmark)
16. brown `#a2845e`

---

## 4. Stroke panel popover (photo 5)

Opened from the stroke/thickness control. A floating card, same visual
language as the colour panel, anchored near the tool island.

```
┌────────────────────────────────────────┐
│ Stroke                                 │
│  ▬▬▬▬▬▬▬▭▭▭▭▭▭▭  ( 3 )              │  ← thickness slider + value bubble
│  [〰] [〰] [⁝⁝] [····]                  │  ← 4 line-style buttons
│  Colors                         ( 🎨 ) │
│  ● ● ● ● ● ● ● ●                       │
│  ● ● ● ● ○ ● ✓ ●                       │
│        ● ● ● ●                          │
└────────────────────────────────────────┘
```

### 4a. Thickness slider
- A horizontal track rendered as a row of small **tick marks / dashes** that get
  longer and denser toward the right (a "ruler" look, not a plain line).
- A round **thumb bubble** sits on the track showing the current value as a
  number (`3`). The bubble has a little pointer/notch down to the track.
- The bubble overlaps the track (it sits above it), so the track must be
  rendered *under* the bubble.

### 4b. Line styles — four buttons
| # | Glyph | Style |
|---|-------|-------|
| 1 | smooth wavy line, **selected** (blue outline + blue-tinted fill) | Solid |
| 2 | faint, thin, low-contrast wave | Thin / light |
| 3 | short dashes | Dashed |
| 4 | fine dots | Dotted |

The selected one has a **blue rounded-rect border and a pale blue fill**; the
others are plain grey rounded rects. These are *stroke textures*, orthogonal
to thickness.

### 4c. Colours
The same colour panel as §3, embedded in the lower half of the stroke card.

---

## 5. Shape tool + selection transform (photo 5)

### 5a. Shape selection
- A stroke (the handwritten matrix) is **selected**: a **blue dashed rectangle**
  with rounded corners surrounds it.
- **4 round blue handles**, one centred on each corner.
- A **rotation handle**: a short horizontal line leaving the right edge
  midpoint, ending in a small **grey/dark dot**.

So the transform UI = dashed bbox + 4 corner handles + 1 rotation handle.
(Note: no mid-edge handles visible, and no scale-from-edge handle — only
corners. Worth confirming whether mid-edge handles appear when a *shape* rather
than a stroke is selected.)

### 5b. What shape types exist
Not directly visible in the photos (the shape submenu was not opened). Per
Notability: **Line, Rectangle, Ellipse/Circle, Triangle, Arrow** — agreed with
the user previously as "line, rectangle, ellipse, triangle, arrow". Treat this
as the target set, unverified from the photos.

---

## 6. Ruler + rotation dial (photo 2 only)

### 6a. Ruler
A horizontal ruler overlays the top of the page area, ~55pt tall, spanning the
full width. Light grey band with darker tick marks:
- numbered `5 4 3 2 1` to the left of centre and `1 2 3 4 5` to the right
- the centre (page origin) is unnumbered
- minor ticks between the numbered marks, one longer tick per unit
- the ruler is **interactive**: it can be dragged, and the pen can be "captured"
  against the ruler edge to draw straight lines
- a **vertical ruler** is also present along the left edge (visible as a grey
  strip with `5 4 3 2 1` running down it)

The ruler appears/disappears with a toggle and is **not** present in photo 3.

### 6b. Rotation dial
Floating in the middle of the page (photo 2), a circular dial ~110pt across:
- a ring of fine tick marks around the circumference
- `0°` centred inside, in small dark text
- soft shadow, white face

This is the page-rotation indicator: it appears while rotating and lets you
snap rotation to fine increments. It sits over the content, centred.

---

## 7. Library screen (photos 6, 7)

A completely different screen — a two-pane layout, **not** a canvas.

### 7a. Left sidebar (~320pt, light grey `#f2f2f7` background)
Top to bottom:
1. **Gear** icon (settings), top-left, alone on its row
2. **Search field** — rounded, white, magnifier icon + "Search" placeholder
3. Nav list:
   - `Home` (house icon) — **selected**, shown on a rounded grey pill
   - `Notes` (notebook-with-pencil icon)
   - `Gallery` (picture icon)
4. `Folders` label (small grey caps) with a **`+`** on the right
5. Folder tree — each folder = a **coloured dot** + name:
   - `Kines 160N` (pink dot)
   - `Sophomore Year` (blue dot) — expandable, has a `›` chevron
     - `Cas100A` (grey dot), `Bio161` (brown), `Statics 211` (teal),
       `MATH 252` (magenta), `Math 220` (purple, **selected**, with a **count
       badge `36`** on the right)
   - `Personal` (blue dot)
   - `Freshman Year` (cyan dot) — expandable, `›` chevron
   - dots are the **subject colours**; the selected folder's text is **bold**

### 7b. Right pane — Home
Top-right cluster: **bell** icon (with a small red badge dot), **circle with
three dots**, and a blue **`+ New`** pill button.

Body, centred, max-width ~640pt:
1. **Notability logo** (the blue notebook-and-pen mark)
2. **`Let's get started`** — large, heavy, black display type
3. A pull-quote in grey: *"Do not wait to strike till the iron is hot; but make it hot by striking."* — William Butler Yeats
4. **Three action cards**, side by side, rounded ~14pt, each with a tinted
   background and a big centred icon + bold label:
   - `Record a lecture` — microphone icon, **orange/peach** tint
   - `Import a file` — download-into-tray icon, **blue** tint
   - `Find a template` — document icon, **grey** tint
5. **`Recent notes`** (large bold heading)
   - a horizontal carousel of note cards: rounded white card with a shadow,
     containing a **page thumbnail preview** (a rendering of the note's first
     page), then a **bold title**, then a **date** (`Oct 21, 20…`) and a
     **subject tag chip** (a coloured rounded pill with the subject name,
     e.g. `Math 220` on a purple chip)
   - cards scroll horizontally, next card partially visible at the edge
6. **`Daily Brain Break`** (large bold heading)
   - a **wide banner card**: blue `NEW` flag in the top-left corner, `Day 1`
     bold + `Sliding Puzzle` grey subtitle on the left, and a large
     puzzle-tile illustration on a periwinkle panel on the right

### 7c. Right pane — folder contents (photo 7)
- Heading = the folder name, **very large and bold** (`Math 220`)
- A **vertical list** of notes. Each row:
  - a small **rounded thumbnail** of the note's first page (~56×76pt, white,
    shadow, rounded corners)
  - the **note title** (regular weight, ~17pt)
  - the **date**, right-aligned, grey (`Oct 21, 2026`)
  - rows separated by hairlines
- No visible thumbnails grid here — it is a list, not a grid.

---

## 8. Derived design tokens

| Token | Value (from photos) |
|---|---|
| Accent blue | `#0a84ff` |
| Pill background | `#ffffff` with ~0.9 alpha + blur |
| Pill radius | ~20pt (toolbar), ~14pt (cards), ~10pt (buttons) |
| Card shadow | `0 8px 30px rgba(0,0,0,.16)`-ish, soft |
| Icon colour | `#4a4a4a`; selected → accent blue |
| Selected swatch | black fill + white checkmark |
| Segmented selected | accent border + pale accent fill (`#e8f2ff`) |
| Sidebar grey | `#f2f2f7` |
| Type | San Francisco (system-ui on iOS); display headings are heavy (800) |

---

## 9. Feature inventory to build (ordered by user impact)

| # | Feature | Depends on |
|---|---------|-----------|
| 1 | Pen / marker / pencil / eraser tools, icon buttons | — |
| 2 | Expandable tool island (2 rows) | 1 |
| 3 | Colour panel popover + palette pages + colour wheel | 1 |
| 4 | Stroke panel (thickness slider + 4 line styles) | 3 |
| 5 | Shapes (line, rect, ellipse, triangle, arrow) + Freeform/Boxed | 2 |
| 6 | Lasso select + dashed bbox + corner/rotate handles | pan/zoom |
| 7 | Ruler (H+V) + rotation dial | pan/zoom |
| 8 | Multi-page notes + page strip | persistence |
| 9 | Library: folders, search, note list, thumbnails, import | persistence |
| 10 | Export / share / print | 8 |

Nothing in §7 (library) is worth building before persistence (IndexedDB)
exists — a library with no storage is a mock.
