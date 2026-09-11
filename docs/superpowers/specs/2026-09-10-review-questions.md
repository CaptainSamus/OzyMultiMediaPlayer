# Questions for Mark at the full-implementation review

Deferred decisions to raise once v1 is complete and Mark walks the whole app.

1. **Timeline lanes: scrub on the lanes?** In expanded mode the playhead and
   scrub live on the bar strip under the lanes; clicking a lane marker jumps
   but dragging on a lane does nothing. Should dragging anywhere on a lane
   scrub the group (small follow-up)? Raised 2026-09-10 after Task 7.

2. **Portable exe relaunch lag.** Launching the portable exe a second time
   (e.g. double-clicking another .mvp while the app is open) takes 8–12 s
   before the session lands in the running window, because the portable
   wrapper re-extracts ~136 MB on every launch before reaching the
   single-instance lock. The installer build does it in under 6 s. Live
   with it, or prefer the installer for people who open many sessions?
   Raised 2026-09-10 after Task 15.

3. **Sidebar right-click on local rows** opens a one-item menu ("Show in
   Explorer"). Mark first asked for a straight right-click → Explorer.
   Keep the menu (room for more actions) or go direct? Raised after Task 14.

4. **YouTube tile duration before first play.** YouTube's embed reports
   duration 0 until the video has played once, so a fresh YouTube tile shows
   no pins and no length on the timeline until then. Fetching the duration
   via yt-dlp when the tile is added would fix it at ~2 s per tile. Worth it?
   Raised 2026-09-11 after Task 21.

5. **Middle-drag over embedded pictures.** Decided 2026-09-11: keep as
   built. Middle-drag pans from anywhere except the YouTube/Twitch picture
   itself (the iframe swallows the press); Pan + zoom on makes it work there
   too. Revisit only if it keeps annoying.
