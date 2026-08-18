# Social-card fonts

`Inter-Regular.ttf` and `Inter-ExtraBold.ttf` are static faces from the Inter
4.1 release. resvg 2.6 does not apply Inter Variable's `wght` axis, so these
faces are required for Regular copy and ExtraBold titles. The Worker embeds
them in `../social-card-fonts.ts` so Vite and Wrangler load the same bytes.
Inter is © 2016 The Inter Project Authors and is licensed under the SIL Open
Font License 1.1. The licence text is in `public/fonts/OFL.txt`.
