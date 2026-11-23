# 餐序｜多商户点餐 Demo

根据《中期汇报v3(2)》第 7–9 页制作的网页演示。顾客扫描门店码进入菜单，选餐后模拟支付。服务端分配取餐号并生成同号制作单，商家在工作台查看订单、标记出餐和模拟补打。

顾客端和商家端页头的日夜开关参考 [YipThim123 的 SunMoon 组件](https://github.com/YipThim123/sun_moon_public/blob/develop/src/components/SunMoon.vue)。浏览器会记住所选主题。

## 一键启动

1. 在服务器电脑上双击 `启动点餐Demo.cmd`。需要 Node.js 22.13 或更高版本。启动文件会运行服务并打开[商家入口分享页](http://127.0.0.1:8787/demo)。
2. 等页面显示「公网入口已就绪」，复制网址发给参与演示的商家。保持启动窗口运行，演示结束后按 Enter 停止。
3. 商家扫码或打开分享网址即可进入注册页，使用各自的手机号和密码注册。已有账号可切换到登录。注册后可在「门店设置」填写资料，在「菜单管理」录入餐品，在「点餐二维码」复制本店链接或下载二维码。
4. 顾客扫描某家店的二维码进入该店菜单。模拟支付后可查看订单和取餐号。取餐号按门店和北京时间日期从 001 起排，各店分别查看制作单、标记出餐和确认取餐。

启动文件使用已配置的 Cloudflare 客户端建立临时公网入口。每次重启后，以分享页显示的当前网址为准，商家可从后台下载更新后的点餐码。若公网连接不可用，分享页会显示局域网入口或本机状态。也可通过 `CLOUDFLARED_PATH` 指定已安装客户端，或配置固定的 `PUBLIC_BASE_URL`。只运行本地服务时，在项目目录执行 `npm ci` 和 `npm start`。

启动时由 Cloudflare 自动选择 QUIC 或 HTTP/2。若校园网仍无法连接，请让网络管理员核查到 Cloudflare Tunnel 的出站 UDP 和 TCP 7844。详见 [Cloudflare 的防火墙要求](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)。

登录商家后台后，可在侧栏点击「重置密码」，输入当前密码和两遍新密码。保存后需要重新登录。

## 数据与配置

| 配置 | 用途 |
| --- | --- |
| `PORT` | 默认 8787。 |
| `HOST` | 默认 `0.0.0.0`，供局域网访问。设为 `127.0.0.1` 时仅本机访问。 |
| `DATA_DIR` | 默认 `runtime/data`。该目录的 `ordering.sqlite` 保存商家账号、登录会话、门店、菜单、图片、订单和模拟打印任务。 |
| `PUBLIC_BASE_URL` | 反向代理部署后填写公开站点根地址，如 `https://order.example.com`。点餐码优先使用该地址，HTTPS 地址会开启安全 Cookie。 |
| `CLOUDFLARED_PATH` | 一键启动时使用的 Cloudflare 客户端路径，默认使用本机项目内的 `runtime/tunnel/portable/cloudflared/cloudflared.exe`。 |

注册时为账号创建一个空白门店。数据按门店隔离，密码存储为带盐哈希。旧版已注册商家的资料会首次导入 SQLite，保留原账号、门店编号和订单。备份时先停止服务，再保存数据库文件。

本次交付运行模拟支付和模拟出票。实际部署时使用 HTTPS，并接入商户支付与打印厂商接口。联调地址、请求格式和适配入口见 [接口说明](docs/API.md)。
