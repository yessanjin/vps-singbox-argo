const express = require("express");
const app = express();
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);

// --- 环境变量 ---
const PORT = process.env.PORT || 3000;
const MAIN_PORT = process.env.XRAY_PORT || 8000; // Reality(TCP) & Hy2(UDP)
const TUIC_PORT = 8001;                          // Tuic(UDP)
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913';
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const CFIP = process.env.CFIP || 'www.visa.com.sg';
const NAME = process.env.NAME || 'VPS';
const SUB_PATH = process.env.SUB_PATH || 'sub';

// Reality 配置
const REALITY_PRIVATE_KEY = process.env.REALITY_PRIVATE_KEY || ''; 
const REALITY_SHORT_ID = process.env.REALITY_SHORT_ID || '';
const REALITY_DEST = process.env.REALITY_DEST || 'www.apple.com:443';
const REALITY_SERVER_NAME = process.env.REALITY_SERVER_NAME || 'www.apple.com';

// 内部端口规划 (避开 8001, 因为要给 Tuic 用)
const FILE_PATH = '/app/bin';
const INTERNAL_ARGO_PORT = 8080;
const INTERNAL_VMESS_PORT = 10001;
const INTERNAL_TROJAN_PORT = 10002;

if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const singboxPath = path.join(FILE_PATH, 'sing-box');
const cloudflaredPath = path.join(FILE_PATH, 'cloudflared');
const subPath = path.join(FILE_PATH, 'sub.txt');
const configPath = path.join(FILE_PATH, 'config.json');
const certPath = path.join(FILE_PATH, 'cert.pem');
const keyPath = path.join(FILE_PATH, 'key.pem');

let generatedPublicKey = "";

app.get("/", (req, res) => res.send(`Sing-box (Hy2/Tuic) Running... Access /${SUB_PATH} to get links.`));

// --- 工具函数 ---

async function downloadFile(url, dest) {
  console.log(`Downloading: ${url}`);
  await execAsync(`curl -L -o "${dest}" "${url}"`);
}

// 生成自签名证书 (给 Hy2 和 Tuic 使用)
async function generateSelfSignedCert() {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return;
  console.log("Generating Self-Signed Certificate for Hy2/Tuic...");
  // 生成有效期 10 年的自签名证书，Common Name 设为 bing.com 伪装
  const cmd = `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -keyout "${keyPath}" -out "${certPath}" -days 3650 -subj "/C=US/ST=California/L=San Francisco/O=Bing/CN=www.bing.com"`;
  await execAsync(cmd);
}

// 获取 Reality 密钥
async function getRealityKeys() {
  if (REALITY_PRIVATE_KEY) return { privateKey: REALITY_PRIVATE_KEY, publicKey: "" };
  try {
    const { stdout } = await execAsync(`"${singboxPath}" generate reality-keypair`);
    const privateMatch = stdout.match(/PrivateKey: (.+)/);
    const publicMatch = stdout.match(/PublicKey: (.+)/);
    if (privateMatch) return { privateKey: privateMatch[1].trim(), publicKey: publicMatch ? publicMatch[1].trim() : "" };
  } catch (e) {}
  return { privateKey: "", publicKey: "" };
}

// --- 生成 Sing-box 配置文件 ---
async function generateSingboxConfig(privateKey) {
  const config = {
    log: { level: "warn", timestamp: true },
    inbounds: [
      // 1. Reality (TCP 8000) - 兼容性好
      {
        type: "vless", tag: "vless-in", listen: "::", listen_port: parseInt(MAIN_PORT),
        users: [{ uuid: UUID, flow: "xtls-rprx-vision" }],
        tls: {
          enabled: true, server_name: REALITY_SERVER_NAME,
          reality: { enabled: true, handshake: { server: REALITY_DEST, server_port: 443 }, private_key: privateKey, short_id: [REALITY_SHORT_ID] }
        }
      },
      // 2. Hysteria2 (UDP 8000) - 速度之王
      {
        type: "hysteria2", tag: "hy2-in", listen: "::", listen_port: parseInt(MAIN_PORT),
        users: [{ password: UUID }],
        tls: { enabled: true, certificate_path: certPath, key_path: keyPath } // 使用自签名证书
      },
      // 3. Tuic v5 (UDP 8001) - 备用速度协议
      {
        type: "tuic", tag: "tuic-in", listen: "::", listen_port: parseInt(TUIC_PORT),
        users: [{ uuid: UUID, password: UUID }],
        congestion_control: "bbr",
        tls: { enabled: true, certificate_path: certPath, key_path: keyPath } // 使用自签名证书
      },
      // 4. Argo 内部路由 (TCP 8080)
      {
        type: "vless", tag: "argo-in", listen: "127.0.0.1", listen_port: INTERNAL_ARGO_PORT,
        users: [{ uuid: UUID }],
        sniff: true, sniff_override_destination: true
      },
      // 5. VMess 内部 (TCP 10001)
      {
        type: "vmess", tag: "vmess-in", listen: "127.0.0.1", listen_port: INTERNAL_VMESS_PORT,
        users: [{ uuid: UUID, alterId: 0 }],
        transport: { type: "ws", path: "/vmess" }
      },
      // 6. Trojan 内部 (TCP 10002)
      {
        type: "trojan", tag: "trojan-in", listen: "127.0.0.1", listen_port: INTERNAL_TROJAN_PORT,
        users: [{ password: UUID }],
        transport: { type: "ws", path: "/trojan" }
      }
    ],
    outbounds: [{ type: "direct", tag: "direct" }, { type: "block", tag: "block" }]
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

async function getPublicIP() {
  try { return (await axios.get('https://api.ipify.org?format=json', { timeout: 5000 })).data.ip; } catch (e) { return "127.0.0.1"; }
}

async function installAndRun() {
  // 安装 Sing-box
  if (!fs.existsSync(singboxPath)) {
    const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
    const url = `https://github.com/SagerNet/sing-box/releases/download/v1.8.0/sing-box-1.8.0-linux-${arch}.tar.gz`;
    const tarPath = path.join(FILE_PATH, 'sing-box.tar.gz');
    await downloadFile(url, tarPath);
    await execAsync(`tar -xzf "${tarPath}" -C "${FILE_PATH}" --wildcards "*/sing-box" --strip-components=1`);
    await execAsync(`chmod +x "${singboxPath}"`);
    fs.unlinkSync(tarPath);
  }
  // 安装 Cloudflared
  if (!fs.existsSync(cloudflaredPath)) {
    const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
    await downloadFile(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`, cloudflaredPath);
    await execAsync(`chmod +x "${cloudflaredPath}"`);
  }

  // 生成证书
  await generateSelfSignedCert();

  // 获取 Reality Key
  let privateKey = REALITY_PRIVATE_KEY;
  if (!privateKey) {
    const keys = await getRealityKeys();
    privateKey = keys.privateKey;
    generatedPublicKey = keys.publicKey;
  }

  // 启动 Sing-box
  await generateSingboxConfig(privateKey);
  console.log(`Starting Sing-box...`);
  exec(`nohup "${singboxPath}" run -c "${configPath}" > /dev/null 2>&1 &`);

  // 启动 Cloudflared (注意：Argo 路由端口变了)
  let argoCmd;
  if (ARGO_AUTH && ARGO_DOMAIN) {
     if (ARGO_AUTH.includes('TunnelSecret')) {
        fs.writeFileSync(path.join(FILE_PATH, 'tunnel.json'), ARGO_AUTH);
        const tunnelYml = `
tunnel: ${JSON.parse(ARGO_AUTH).TunnelID}
credentials-file: ${path.join(FILE_PATH, 'tunnel.json')}
protocol: http2
ingress:
  - hostname: ${ARGO_DOMAIN}
    path: /vmess
    service: http://localhost:${INTERNAL_VMESS_PORT}
  - hostname: ${ARGO_DOMAIN}
    path: /trojan
    service: http://localhost:${INTERNAL_TROJAN_PORT}
  - hostname: ${ARGO_DOMAIN}
    service: http://localhost:${INTERNAL_ARGO_PORT}
  - service: http_status:404
`;
        fs.writeFileSync(path.join(FILE_PATH, 'tunnel.yml'), tunnelYml);
        argoCmd = `nohup "${cloudflaredPath}" tunnel --config "${path.join(FILE_PATH, 'tunnel.yml')}" run > /dev/null 2>&1 &`;
     } else {
        argoCmd = `nohup "${cloudflaredPath}" tunnel --no-autoupdate --protocol http2 run --token ${ARGO_AUTH} > /dev/null 2>&1 &`;
     }
  } else {
    argoCmd = `nohup "${cloudflaredPath}" tunnel --no-autoupdate --protocol http2 --url http://localhost:${INTERNAL_ARGO_PORT} --logfile "${path.join(FILE_PATH, 'argo.log')}" > /dev/null 2>&1 &`;
  }
  exec(argoCmd);
  setTimeout(generateSubscription, 10000);
}

// 生成订阅
async function generateSubscription() {
  const publicIP = await getPublicIP();
  let domain = ARGO_DOMAIN;
  if (!domain) {
    try {
        const log = fs.readFileSync(path.join(FILE_PATH, 'argo.log'), 'utf8');
        const match = log.match(/https?:\/\/([^ ]*trycloudflare\.com)/);
        if (match) domain = match[1];
    } catch (e) {}
  }
  
  const publicKey = process.env.REALITY_PUBLIC_KEY || generatedPublicKey;
  const nodes = [];
  
  // 1. Hysteria2 (UDP) - 需开启跳过证书验证
  nodes.push(`hysteria2://${UUID}@${publicIP}:${MAIN_PORT}?peer=www.bing.com&insecure=1&obfs=salamander&obfs-password=${UUID}#${encodeURIComponent(NAME + "-Hysteria2")}`);

  // 2. Tuic v5 (UDP) - 需开启跳过证书验证
  nodes.push(`tuic://${UUID}:${UUID}@${publicIP}:${TUIC_PORT}?peer=www.bing.com&insecure=1&congestion_control=bbr#${encodeURIComponent(NAME + "-Tuic-v5")}`);

  // 3. Reality (TCP)
  if (publicKey) {
    nodes.push(`vless://${UUID}@${publicIP}:${MAIN_PORT}?security=reality&encryption=none&pbk=${publicKey}&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=${REALITY_SERVER_NAME}&sid=${REALITY_SHORT_ID}#${encodeURIComponent(NAME + "-Reality-Vision")}`);
  }

  // 4. Argo Tunnel
  if (domain) {
      const vmessArgo = { v: "2", ps: `${NAME}-Argo-VMESS`, add: CFIP, port: "443", id: UUID, aid: "0", scy: "auto", net: "ws", type: "none", host: domain, path: "/vmess", tls: "tls", sni: domain };
      nodes.push(`vmess://${Buffer.from(JSON.stringify(vmessArgo)).toString('base64')}`);
      nodes.push(`trojan://${UUID}@${CFIP}:443?security=tls&sni=${domain}&type=ws&host=${domain}&path=%2Ftrojan#${encodeURIComponent(NAME + "-Argo-Trojan")}`);
  }

  fs.writeFileSync(subPath, Buffer.from(nodes.join('\n')).toString('base64'));
  console.log("Subscription generated.");
}

app.get(`/${SUB_PATH}`, (req, res) => {
    if (fs.existsSync(subPath)) res.send(fs.readFileSync(subPath, 'utf8'));
    else res.status(503).send("Initializing...");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  installAndRun();
});
