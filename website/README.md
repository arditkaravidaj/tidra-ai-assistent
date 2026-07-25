# Tidra Website

The Tidra landing page — static HTML/CSS/JS, no build step.

Black canvas, big white type (Instrument Serif + Inter), and a floating white
nav island. Brand assets and promo videos live in `assets/`.

## Run locally

```bash
python3 -m http.server 4173 --directory website
```

Then open http://localhost:4173.

## Files

- `index.html` — the page
- `style.css` — all styling
- `main.js` — nav hide-on-scroll + section reveal
- `assets/` — icon + `tidra-intro.mp4`, `tidra-promo.mp4`, `tidra-teaser.mp4`
