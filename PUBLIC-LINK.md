# Public test link from this laptop

Free, no account, no router or firewall change. It uses a Cloudflare Quick Tunnel: `cloudflared` on this laptop opens an outbound connection to Cloudflare, and you get an https link such as `https://random-words.trycloudflare.com` that reaches the app running here.

## Start

1. Double-click **START-PUBLIC-LINK.bat**. If the app is not running, it starts it in its own window first.
2. **First time only:**
   - It asks you to set a **Viewer password**. The link is public, and without one anyone with the link could open the status screen.
   - It downloads `cloudflared.exe` into the `tools` folder.
3. **Every time:**
   - It asks whether to change the Admin and Super Admin passwords. Do this before the first share.
   - The link is shown, copied to the clipboard and saved in `tools\public-link.txt`.
4. Send testers the link. Send the Viewer password separately, for example in a different message.

## Stop

Close the window or press Ctrl+C. Only the link stops; the app keeps running.

## Good to know

- **Availability:** the link works only while that window is open and the laptop is on, awake and online. The window keeps the laptop from sleeping, but closing the lid may still put it to sleep (Windows power settings).
- **The link changes** every time you start it.
- **Limits:** this is for testing only. There is no uptime guarantee, and it handles about 200 requests at the same time.
- **Security:**
  - Everything goes over https.
  - Sign-in is checked on the server.
  - Wrong passwords lock that role for 15 minutes (5 per address, 20 in total).
  - Testers see the data on this laptop's database. The ₹ billing columns appear only for Admin and Super Admin.
- **Password commands:**
  - Change the Viewer password: `npm run logins:set -- --role VIEWER`
  - Viewer back to one click with no password (only when you stop sharing): `npm run logins:set -- --role VIEWER --remove`
  - See which roles have a password: `npm run logins:set -- --status`
- **Company policy:** project and billing data leaves the office network through this link. Check with IT that this is allowed for testing.

## If the link does not open

| Message | What to do |
|---|---|
| cloudflared could not be downloaded | Get `cloudflared-windows-amd64.exe` from github.com/cloudflare/cloudflared/releases, rename it `cloudflared.exe`, put it in `tools\`, and run again. The office network may block the download. |
| The tunnel did not open | If `%USERPROFILE%\.cloudflared\config.yml` exists, rename it. Office networks or a VPN can block Cloudflare tunnels; try on another network, such as a phone hotspot. |
| The app did not start | Read the Project Drawing Status window. |
