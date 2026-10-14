# Scripted demo – 1080p video export (local only)

1. Preview server running (`npm run dev:private-preview -- --port 5175 --strictPort`) and a draft built with
   `node scripted-demo/build-fixture.mjs` (or `--scratch` for the environment check).
2. Throwaway headless Chrome, window 1920×1167 (= exact 1920×1080 viewport), temp profile, loopback only:
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --user-data-dir=<tmp> --remote-debugging-port=9333 --remote-allow-origins=http://127.0.0.1 --window-size=1920,1167 --force-device-scale-factor=1 --autoplay-policy=no-user-gesture-required --no-first-run --disable-extensions about:blank &`
3. Frames (virtual clock, one frame per 1/30 s of the audio): `node scripted-demo/video/render-frames.mjs "http://127.0.0.1:5175/?draft=<id>" <outDir> 30`
4. Encode (H.264 1920×1080 30 fps CFR + AAC stereo from the mix WAV) and verify:
   `swift scripted-demo/video/encode.swift <outDir>/frames production/scripted-demo/out/<mix>.wav exports/<name>.mp4 <sheet.png>`
