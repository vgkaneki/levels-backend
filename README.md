# No-ZIP backend host files

Use these files when a platform does not accept ZIP uploads.

Required file tree:

```text
package.json
server.mjs
exported-levels-engine/
  dist/
    index.js
```

Runtime:
- Node 20+
- Start command: `npm start`
- The host must expose the `PORT` environment variable, or the server will default to port `3000`.

Environment variables:
- `CORS_ORIGIN=*` for testing, or set it to your Sider/frontend origin later.

Health test:
```text
/api/health
```

Main frontend endpoint:
```text
/api/levels/all-source-overlap?symbol=BTC&interval=4h&minStrength=strong&limit=20&includeLive=true
```

In the Sider API Base URL panel, paste only the origin, for example:

```text
https://your-backend-name.example.com
```

Do not paste the full `/api/levels/all-source-overlap` endpoint into the API Base field.
