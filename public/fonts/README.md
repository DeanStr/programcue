# Fonts

`inter-latin-var.woff2` and `inter-latin-ext-var.woff2` are the latin and
latin-ext subsets of **Inter Variable**, copied verbatim from
[`@fontsource-variable/inter`](https://www.npmjs.com/package/@fontsource-variable/inter)
version 5.3.0 (`files/inter-latin-wght-normal.woff2` and
`files/inter-latin-ext-wght-normal.woff2`).

Inter is © 2016 The Inter Project Authors and is licensed under the SIL Open
Font License 1.1. The full licence text is in `OFL.txt` and must ship with
these binaries.

They are checked in rather than resolved through the bundler so the `@font-face`
in `app/styles/tokens.css` can reference a stable path that `app/root.tsx` also
preloads. To update, reinstall the package, copy the two files and refresh
`OFL.txt` from the same version.
