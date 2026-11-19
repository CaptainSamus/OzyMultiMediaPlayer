# Miro crops from screenshots

Miro's API does not say which part of a picture a crop keeps (only the cropped size), so an import
shows the middle of each cropped picture. This tool works the real crops out from screenshots of
the Miro board and writes `miro-crops.json` next to the board; the next **Import from Miro** uses
them ("cropped exactly as in Miro" in its summary). Needs Python with numpy and OpenCV (`cv2`).

```
python -I cropfind.py "<board folder>" "<board folder>/miro-crops.json" shot1.png [shot2.png ...]
```

Each screenshot is placed on the board by itself (from uncropped pictures it can see). Hints help
when it cannot be (a screenshot of nothing but cropped pictures), as environment variables, per
screenshot number: `HINT1='{"s":0.0167}'` (screen pixels per Miro unit), or a full placement
`EXACT1='{"s":0.016672,"X0":231821,"Y0":-198146}'` (screen = (board - X0/Y0) * s). Useful switches:
`MASKFIT=1` (place by the outline of all pictures), `MASKOVERLAP=1` (compare only the parts of a
picture no other covers), `SAMESHAPE=1` (also find crops that keep the file's shape), `WIDE=40`
and `STEPS=140` (look for tighter crops), `ONLYWEAK=1` (only redo the weak matches).
Matches scoring under 0.7 are not used by the import.

First used 2026-11-06 on Mark's "Character list" board: 235 crops from two screenshots.
