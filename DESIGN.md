---
version: 1.0
colors:
  background: "#07090d"
  surface: "#0d1118"
  text: "#f4f0e8"
  muted: "#9b9ca5"
  accent: "#d2a36f"
  accentBright: "#f5d4a8"
typography:
  display:
    fontFamily: "Playfair Display, Georgia, serif"
    fontSize: "clamp(2rem, 4.5vw, 3.4rem)"
    lineHeight: "1.05"
  ui:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "1rem"
    lineHeight: "1.5"
  utility:
    fontFamily: "DM Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    lineHeight: "1.4"
rounded:
  small: "8px"
  medium: "14px"
  large: "20px"
spacing:
  page: "clamp(18px, 5vw, 72px)"
  section: "72px"
components:
  buttons:
    radius: "999px"
    focus: "2px solid #ffdfb5"
  cards:
    radius: "10px"
    border: "1px solid rgba(244, 240, 232, 0.12)"
  player:
    radius: "20px"
    backdrop: "rgba(4, 5, 8, 0.88)"
---

# StreamVault viewer design context

## Overview

StreamVault is a private cinema for invited viewers. The interface is an editorial
film index: full-bleed imagery establishes the mood, poster-first browsing keeps the
collection scannable, and the player stays quiet until it is needed. Playback controls
and authentication states prioritize clarity and recovery over technical detail.

The signature is a warm ivory-and-copper palette on blue-black, with Playfair titles
and a single strong action color. Keep the chrome sparse: no competing CTA colors,
no feature-card mosaics, and no implementation language in primary user copy.

## Colors

Night black is the canvas, blue-black is the working surface, and copper is reserved
for focus, selection, and primary playback actions. Green is semantic only for an
active secure session. Error red is reserved for playback/authentication failure.

## Typography

Playfair Display gives film titles an editorial voice. Outfit carries controls and
navigation. DM Mono is reserved for compact metadata, session state, and technical
labels. System fallbacks keep the layout usable if web fonts are unavailable.

## Layout

The desktop shell uses a full-width sticky nav and edge-to-edge hero. Below it,
continue-watching is a horizontal rail and the main collection is a poster-first grid
with metadata beneath each image. The sign-in screen uses a split editorial layout:
one clear invitation and a quiet capability list. The player is an app-owned modal
that locks background scroll and restores focus when closed.

## Elevation & Depth

Depth comes from poster vignettes, restrained shadow on interactive artwork, and blur
only where it clarifies the sticky nav or player overlay. Poster metadata is always
visible; play affordances reveal on hover and remain available to keyboard focus.

## Shapes

Pills are reserved for actions, filters, and session status. Cards and panels use the
medium radius. Focus rings are always visible and are never replaced by color alone.

## Components

The existing CSS token layer is the runtime source of truth. Runtime values live in
`web/src/style.css` and are kept in the same changeset when the visual system changes.
Native buttons and links own interaction semantics. The expanded player is the
canonical playback overlay.

## Do's and Don'ts

- Do keep movie art, title, and year visible without hover; make play intent obvious on focus.
- Do use sentence case for user actions and short, specific recovery copy.
- Do preserve keyboard shortcuts, visible focus, reduced motion, and touch targets.
- Don't expose implementation language as the primary user copy.
- Don't make a card clickable only through hover or a non-semantic container.
