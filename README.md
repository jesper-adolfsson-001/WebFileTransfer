# WebFileTransfer

WebFileTransfer is a lightweight Node 16/Fastify web app that lets you move photos from any phone to a computer on the same network **without installing anything**.  
Pair the two browsers with a one-time QR-code, shoot/select pictures on the phone, and they appear (and can auto-download) on the desktop almost instantly.

---


# How it works

- Receiver (desktop) browses to /receiver: The server starts a short-lived session and renders a QR-code.
- Sender (phone) scans the code → opens /sender?SessionId=… : The page lets you take or pick photos and POSTs them to the server.
- The receiver page polls /status/:sessionId, fetches each file via : /image/:sessionId/:imageId, shows a thumbnail and (optionally) saves it locally using FileSaver.js.
- Sessions time out automatically (default 2 min) to clean up storage.

# Key files

- public/receiver.js – Receiver logic (polling and downloading)
- public/sender.js – Sender logic (taking/selecting photos)
- public/admin.js - Admin view for event logging
- server.js – Session and upload handling
- log-service.js – Logging events to .data/events.log
- views/ – EJS templates for receiver, sender, admin views

# Main endpoints

- POST /api/session/request – Receiver asks for a session; returns {sessionId, qrCodeData}
- POST /api/session/:id/connect – Sender announces it joined
- POST /upload/:id – Multipart photo upload
- GET /status/:id – Receiver polls for pending files / peer presence
- GET /image/:id/:imageId – Fetch and delete one image
- GET /admin – View logs Basic-Auth dashboard (set ADMIN_CREDENTIALS)

# Environment Variables
| Env var              | Default        | Description                        |
|----------------------|----------------|------------------------------------|
| `PORT`               | `3000`         | HTTP port                          |
| `SESSION_TIMEOUT_MS` | `120000`       | Session lifetime                   |
| `CLIENT_TIMEOUT_MS`  | `3000`         | Client-side fetch timeout          |
| `UPLOAD_DIR`         | `.data/uploads`| Temp image storage                 |
| `ADMIN_CREDENTIALS`  | user:pass      | to enable `/admin`   |



## You built this with Glitch!

[Glitch](https://glitch.com) is a friendly community where millions of people come together to build web apps and websites.

- Need more help? [Check out our Help Center](https://help.glitch.com/) for answers to any common questions.
- Ready to make it official? [Become a paid Glitch member](https://glitch.com/pricing) to boost your app with private sharing, more storage and memory, domains and more.
