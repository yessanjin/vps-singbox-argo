# 🚀 VPS Sing-box All-in-One (Hy2 + Tuic + Reality + Argo)

这是一个专为 **VPS 环境** 打造的**全能、极速**代理部署方案。

本项目以 **Sing-box** 内核，集成了目前公认速度最快的 **Hysteria2** 和 **Tuic v5** 协议（基于 UDP），同时保留了稳定的 **Reality** (TCP) 和 **Cloudflare Argo Tunnel** (隧道)。

---

## ✨ 项目亮点

*   **🏎️ 速度之王**: 集成 **Hysteria2** 和 **Tuic v5**，基于 UDP 的拥塞控制，在晚高峰和垃圾线路也能跑满带宽。
*   **🛡️ 稳如泰山**: 保留 **Reality (Vision)** 直连协议，伪装成 Apple/Microsoft，通过 TCP 传输，最难被检测。
*   **☁️ 永不失联**: 集成 **Cloudflare Argo Tunnel**，通过物理分流技术（Path Routing），即使 VPS IP 被墙也能通过隧道救活。
*   **📜 自动证书**: 自动生成自签名证书，无需域名即可使用 Hy2 和 Tuic（需客户端开启跳过验证）。
*   **🔒 安全隐私**: 支持自定义订阅路径，防止被恶意扫描。

---

## 🛠️ 节点列表 (共 5 个)

1.  **🚀 Hysteria2** (UDP): **[推荐]** 速度极快，抢占带宽能力强。
2.  **🚀 Tuic v5** (UDP): **[推荐]** 另一种基于 QUIC 的高速协议。
3.  **🛡️ Reality-Vision** (TCP): 传统的 VLESS 直连，延迟低，无需配置客户端跳过证书。
4.  **☁️ Argo-VMess** (WS+TLS): 隧道节点，通过 CF 中转。
5.  **☁️ Argo-Trojan** (WS+TLS): 隧道节点，通过 CF 中转。

---

## 📋 部署指南

### 第一步：生成 Reality 密钥 (必须)

在 VPS 上运行以下命令生成密钥对：

```bash
docker run --rm ghcr.io/xtls/xray-core:latest x25519
```

**记下输出结果**：
*   `Private key`: 私钥（填入 `REALITY_PRIVATE_KEY`）
*   `Public key`: 公钥（填入 `REALITY_PUBLIC_KEY`）

---

### 第二步：配置 Cloudflare Tunnel (关键)

> ⚠️ **注意**：由于 8001 端口被 Tuic 占用，Argo 的内部端口已变更，请务必按以下表格配置！

1.  登录 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) -> **Networks** -> **Tunnels**。
2.  进入你的 Tunnel 配置 -> **Public Hostname**。
3.  添加或修改以下 **3 条规则** (假设域名是 `vps.example.com`)：

| 子域 | 域名 | 路径 | 服务 类型 | 服务 URL | 说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `vps-singbox-argo` | `example.com` | **vmess** | HTTP | HTTP | **`localhost:10001`** | VMess 专用 (注意是10001) |
| `vps-singbox-argo` | `example.com` | **trojan** | HTTP | **`localhost:10002`** | Trojan 专用 (注意是10002) |
| `vps-singbox-argo` | `example.com` | *(留空)* | HTTP | `localhost:8080` | 默认兜底 |

---

### 第三步：创建与启动容器

创建 `docker-compose.yml` 文件：

```bash
mkdir -p proxy && cd proxy
vim docker-compose.yml
```

粘贴以下内容（**修改 UUID、密钥、Token 和 SUB_PATH**）：

```yaml
version: '3.8'

services:
  vps-proxy:
    image: ghcr.io/yessanjin/vps-singbox-argo:latest
    container_name: vps-proxy
    restart: always
    ports:
      - "3000:3000/tcp"  # 订阅服务
      - "8000:8000/tcp"  # Reality 直连
      - "8000:8000/udp"  # Hysteria2 (必须暴露UDP)
      - "8001:8001/udp"  # Tuic v5 (必须暴露UDP)
    
    environment:
      # --- 🔑 核心鉴权 ---
      - UUID=9afd1229-b893-40c1-84dd-51e7ce204913   # ⚠️ 修改这里！
      - SUB_PATH=my-secret-token-123                # ⚠️ 自定义订阅路径，防止被扫
      
      # --- 💎 REALITY 配置 (见第一步) ---
      - REALITY_PRIVATE_KEY=xxxxxxxxxxxxxxxxxxxxxx
      - REALITY_PUBLIC_KEY=xxxxxxxxxxxxxxxxxxxxxxx
      - REALITY_DEST=www.apple.com:443
      - REALITY_SERVER_NAME=www.apple.com
      
      # --- ☁️ Argo 固定隧道配置 ---
      - ARGO_AUTH=eyJhIjoi...                       # ⚠️ 填入 Tunnel Token
      - ARGO_DOMAIN=vps.example.com                 # ⚠️ 填入 CF 后台设置的域名
      
      # --- 基础配置 ---
      - PORT=3000
      - XRAY_PORT=8000
      - NAME=VPS
      - CFIP=www.visa.com.sg
```

启动：
```bash
docker-compose up -d
```

---

### 第四步：获取订阅与客户端设置

1.  **获取订阅**：
    访问：`http://<VPS_IP>:3000/my-secret-token-123` (路径是你设置的 SUB_PATH)。

2.  **客户端特别设置 (必读)**：
    由于 **Hysteria2** 和 **Tuic** 使用了自签名证书（为了支持 IP 直连），在 **V2RayN / Shadowrocket / Nekobox** 中：
    *   必须开启 **Allow Insecure (允许不安全 / 跳过证书验证)**。
    *   否则节点无法连接。

---

## ⚙️ 端口规划详解

| 端口 | 协议 | 说明 |
| :--- | :--- | :--- |
| **8000 (TCP)** | Reality | 传统的 VLESS Vision 直连，伪装为 HTTPS。 |
| **8000 (UDP)** | **Hysteria2** | **极速协议**。共用 8000 端口，对防火墙更友好。 |
| **8001 (UDP)** | **Tuic v5** | **极速协议**。基于 QUIC。 |
| **10001** (内部) | VMess | 仅供 Cloudflare Tunnel 内部转发使用。 |
| **10002** (内部) | Trojan | 仅供 Cloudflare Tunnel 内部转发使用。 |

---

## 📝 常见问题 (FAQ)

**Q: 为什么 Hy2 和 Tuic 连不上？**
A:
1. 检查 VPS 防火墙是否放行了 **UDP** 8000 和 8001 端口。
2. 检查客户端是否开启了 **"允许不安全/跳过证书验证"**。

**Q: Argo 节点连不上？**
A: 请务必检查 Cloudflare 后台的 Public Hostname 配置，**Path** 必须配置正确，且端口需指向 **10001** (VMess) 和 **10002** (Trojan)，**不再是之前的 8001/8002**。

**Q: 自签名证书安全吗？**
A: 流量本身是加密的，自签名证书只是无法通过浏览器的信任链验证。对于翻墙用途，配合 `Allow Insecure` 使用是安全的，且能省去申请域名的麻烦。

---

## ⚠️ 免责声明

本项目仅供技术研究和学习使用。请遵守当地法律法规，严禁用于任何非法用途。开发者不对使用本项目产生的任何后果负责。
