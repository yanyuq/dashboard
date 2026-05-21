const fs = require('fs');

const config = {
    auth0Auth: process.env.NETBIRD_USE_AUTH0 === "false" || process.env.USE_AUTH0 === "false",
    authAuthority: process.env.AUTH_AUTHORITY || "",
    authClientId: process.env.AUTH_CLIENT_ID || "",
    authClientSecret: process.env.AUTH_CLIENT_SECRET || "",
    authScopesSupported: process.env.AUTH_SUPPORTED_SCOPES || "",
    authAudience: process.env.AUTH_AUDIENCE || "",
    apiOrigin: process.env.NETBIRD_MGMT_API_ENDPOINT || "",
    grpcApiOrigin: process.env.NETBIRD_MGMT_GRPC_API_ENDPOINT || "",
    redirectURI: process.env.AUTH_REDIRECT_URI || "",
    silentRedirectURI: process.env.AUTH_SILENT_REDIRECT_URI || "",
    tokenSource: process.env.NETBIRD_TOKEN_SOURCE || "",
    dragQueryParams: process.env.NETBIRD_DRAG_QUERY_PARAMS === "false",
    hotjarTrackID: process.env.NETBIRD_HOTJAR_TRACK_ID || "",
    googleAnalyticsID: process.env.NETBIRD_GOOGLE_ANALYTICS_ID || "",
    googleTagManagerID: process.env.NETBIRD_GOOGLE_TAG_MANAGER_ID || "",
    wasmPath: process.env.NETBIRD_WASM_PATH || ""
};

// 覆盖根目录的 config.json，供 Next.js 构建时 require 读取
fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
console.log("✅ 环境变量已在构建阶段成功注入到 config.json！");