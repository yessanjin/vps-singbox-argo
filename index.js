const express = require("express");
const app = express();
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);

// --- 环境变量配置 ---
const PORT = process.env.PORT || 3000;
const SB_PORT = process.env.XRAY_PORT || 8000; // Sing-box 监听端口
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913';
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const CFIP = process.env.CFIP || 'www.visa.com.sg';
const NAME = process.env.NAME || 'VPS';
const SUB_PATH = process.env.SUB_PATH || 'sub';

// --- REALITY 配置 ---
const REALITY_PRIVATE_KEY = process.env.REALITY_PRIVATE_KEY || ''; 
const REALITY_SHORT_ID = process.env.REALITY_SHORT_ID || '';
const REALITY_DEST = process.env.REALITY_DEST || 'www.apple.com:443';
const REALITY_SERVER_NAME = process.env.REALITY_SERVER_NAME || 'www.apple.com';

const FILE_PATH = '/app/bin';
const INTERNAL_ARGO_PORT = 8080;

if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH, { recursive: true });
}

const singboxPath = path.join(FILE_PATH, 'sing-box'); // 核心改名
const cloudflaredPath = path.join(FILE_PATH, 'cloudflared');
const subPath = path.join(FILE_PATH, 'sub.txt');
const configPath = path.join(FILE_PATH, 'config.json');

let generatedPublicKey = "";

app.get("/", (req, res) => {
  res.send(`Sing-box Node Server Running... Access /${SUB_PATH} to get links.`);
});

function getArch() {
  const arch = os.arch();
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  return 'amd64'; // Sing-box 命名习惯: amd64
}

// 下载文件
async function downloadFile(url, dest) {
  console.log(`Downloading: ${url}`);
  await execAsync(`curl -L -o "${dest}" "${url}"`);
  console.log(`Downloaded to ${dest}`);
}

// 获取 Reality 密钥 (调用 sing-box generate)
async function getRealityKeys() {
  if (REALITY_PRIVATE_KEY) {
    return { privateKey: REALITY_PRIVATE_KEY, publicKey: "" }; 
  }
  try {
    // Sing-box 生成密钥命令
    const { stdout } = await execAsync(`"${singboxPath}" generate reality-keypair`);
    // 输出: PrivateKey: xxx \n PublicKey: yyy
    const privateMatch = stdout.match(/PrivateKey: (.+)/);
    const publicMatch = stdout.match(/PublicKey: (.+)/);
    if (privateMatch && publicMatch) {
      return { privateKey: privateMatch[1].trim(), publicKey: publicMatch[1].trim() };
    }
  } catch (e) {
    console.error("Key gen failed:", e);
  }
  return { privateKey: "", publicKey: "" };
}

// --- 生成 Sing-box 配置文件 (完全重写) ---
async function generateSingboxConfig(privateKey) {
  const config = {
    log: {
      level: "warn",
      timestamp: true
    },
    inbounds: [
      // 1. Reality 主入口 (公网 8000)
      {
        type: "vless",
        tag: "vless-in",
        listen: "::",
        listen_port: parseInt(SB_PORT),
        users: [
          {
            uuid: UUID,
            flow: "xtls-rprx-vision"
          }
        ],
        tls: {
          enabled: true,
          server_name: REALITY_SERVER_NAME,
          reality: {
            enabled: true,
            handshake: {
              server: REALITY_DEST,
              server_port: 443
            },
            private_key: privateKey,
            short_id: [REALITY_SHORT_ID]
          }
        }
      },
      // 2. Argo 内部路由入口 (本地 8080) - 兜底
      {
        type: "vless",
        tag: "argo-in",
        listen: "127.0.0.1",
        listen_port: INTERNAL_ARGO_PORT,
        users: [{ uuid: UUID }],
        // 开启 sniff 来识别流量
        sniff: true, 
        sniff_override_destination: true
      },
      // 3. VMess (本地 8001)
      {
        type: "vmess",
        tag: "vmess-in",
        listen: "127.0.0.1",
        listen_port: 8001,
        users: [{ uuid: UUID, alterId: 0 }],
        transport: {
          type: "ws",
          path: "/vmess"
        }
      },
      // 4. Trojan (本地 8002)
      {
        type: "trojan",
        tag: "trojan-in",
        listen: "127.0.0.1",
        listen_port: 8002,
        users: [{ password: UUID }],
        transport: {
          type: "ws",
          path: "/trojan"
        }
      }
    ],
    outbounds: [
      {
        type: "direct",
        tag: "direct"
      },
      {
        type: "block",
        tag: "block"
      }
    ]
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

async function getPublicIP() {
  try {
    const response = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    return response.data.ip;
  } catch (e) {
    return "127.0.0.1";
  }
}

async function installAndRun() {
  // 1. 安装 Sing-box (下载 tar.gz 并解压)
  if (!fs.existsSync(singboxPath)) {
    const arch = getArch();
    // 使用 SagerNet 官方源
    const url = `https://github.com/SagerNet/sing-box/releases/download/v1.8.0/sing-box-1.8.0-linux-${arch}.tar.gz`;
    const tarPath = path.join(FILE_PATH, 'sing-box.tar.gz');
    
    await downloadFile(url, tarPath);
    console.log("Extracting Sing-box...");
    // 解压 tar.gz, --strip-components=1 去掉外层文件夹
    await execAsync(`tar -xzf "${tarPath}" -C "${FILE_PATH}" --wildcards "*/sing-box" --strip-components=1`);
    await execAsync(`chmod +x "${singboxPath}"`);
    fs.unlinkSync(tarPath);
  }

  // 2. 安装 Cloudflared (保持不变)
  if (!fs.existsSync(cloudflaredPath)) {
    const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
    await downloadFile(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`, cloudflaredPath);
    await execAsync(`chmod +x "${cloudflaredPath}"`);
  }

  let privateKey = REALITY_PRIVATE_KEY;
  if (!privateKey) {
    const keys = await getRealityKeys();
    privateKey = keys.privateKey;
    generatedPublicKey = keys.publicKey;
  }

  // 3. 运行 Sing-box
  await generateSingboxConfig(privateKey);
  console.log(`Starting Sing-box...`);
  // Sing-box 运行命令
  exec(`nohup "${singboxPath}" run -c "${configPath}" > /dev/null 2>&1 &`);

  // 4. 运行 Cloudflared (路由逻辑不变)
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
    service: http://localhost:8001
  - hostname: ${ARGO_DOMAIN}
    path: /trojan
    service: http://localhost:8002
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

// 生成订阅 (逻辑完全通用，不需要变，因为客户端连接参数是一样的)
async function generateSubscription() {
  const publicIP = await getPublicIP();
  let domain = ARGO_DOMAIN;
  if (!domain) {
    try {
        const logContent = fs.readFileSync(path.join(FILE_PATH, 'argo.log'), 'utf8');
        const match = logContent.match(/https?:\/\/([^ ]*trycloudflare\.com)/);
        if (match) domain = match[1];
    } catch (e) {}
  }
  
  const publicKey = process.env.REALITY_PUBLIC_KEY || generatedPublicKey;
  const nodes = [];
  
  // Sing-box 的 Reality 节点链接格式和 Xray 是一样的
  if (publicKey) {
    nodes.push(`vless://${UUID}@${publicIP}:${SB_PORT}?security=reality&encryption=none&pbk=${publicKey}&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=${REALITY_SERVER_NAME}&sid=${REALITY_SHORT_ID}#${encodeURIComponent(NAME + "-Reality-Vision")}`);
  }

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
