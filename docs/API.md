# 点餐 Demo 接口

接口与网页同源。JSON 请求发送 `Content-Type: application/json`。金额使用整数分，失败返回 `{"error":{"code":"…","message":"…"}}`。商家工作台通过会话 Cookie 鉴权。首次注册、登录和查询会话可在未登录时调用。

## 扫码和顾客下单

| 路由 | 调用方式 |
| --- | --- |
| `GET /` | 跳转到 `/merchant?mode=register`。分享页的商家码直接编码注册页网址。 |
| `GET /?store=<门店ID>` | 门店码落地页。二维码编码该门店的完整点餐地址。 |
| `GET /api/store?store=<门店ID>` | 返回对应门店的信息、分类和已上架餐品。省略 `store` 时返回空首页数据。 |
| `GET /api/queue?store=<门店ID>` | 返回该店已支付且处于 `preparing` 状态的订单数 `{waitingCount}`。 |
| `POST /api/orders?store=<门店ID>` | 提交 `{"items":[{"itemId":"餐品ID","quantity":1}],"note":"少辣"}`。服务端按对应门店的菜单计算金额并保存餐品快照。 |
| `POST /api/orders/:id/pay?store=<门店ID>` | 提交 `{}` 确认模拟支付，生成取餐号和制作单。重复调用沿用原取餐号和制作单。 |
| `GET /api/orders/:id?store=<门店ID>` | 使用订单 ID 查询同一门店的订单。 |

订单包含 `id`、`shopId`、`shopName`、`items`、`totalCents`、`note`、`createdAt`、`paidAt`、`pickupNumber`、`paymentStatus`、`status` 和 `printStatus`。餐品快照包含名称、份数和单价。订单状态依次为 `pending`、`preparing`、`ready`、`picked`。

取餐号按门店和支付时间的北京时间日期分配，从 `001` 依次递增。分配时跳过该门店当日已使用的号码。

## 商家工作台

| 路由 | 用途 |
| --- | --- |
| `GET /api/admin/session` | 返回 `{authenticated}`，用于显示账号操作或工作台。 |
| `POST /api/admin/register` | 公开入口接收 `{"phone":"13800138000","password":"…"}`。手机号唯一，成功后建立会话，并为该账号创建空白门店。 |
| `POST /api/admin/login`、`POST /api/admin/logout` | 手机号和密码登录、退出。登录请求使用 `{"phone":"13800138000","password":"…"}`。 |
| `PUT /api/admin/password` | 登录后提交 `{"currentPassword":"…","newPassword":"…"}`。验证后更新密码、清除该账号的会话，并返回 `{authenticated:false}`。 |
| `GET /api/admin/store`、`PUT /api/admin/shop` | 查询完整菜单及门店信息，更新 `name`、`announcement`、`address`。 |
| `POST /api/admin/categories`、`PUT /api/admin/categories/:id`、`DELETE /api/admin/categories/:id` | 新增、改名和删除分类。编辑字段为 `name`。 |
| `POST /api/admin/items`、`PUT /api/admin/items/:id`、`DELETE /api/admin/items/:id` | 维护餐品字段 `categoryId`、`name`、`priceCents`、`description`、`imageUrl`、`active`。`categoryId` 为 `null`、空字符串或省略时，餐品归为无分类。 |
| `POST /api/admin/upload` | 提交 `{"dataUrl":"data:image/jpeg;base64,…"}`，返回 `{imageUrl}`。支持 PNG、JPEG、WebP，最多 2.5 MB。 |
| `GET /api/admin/orders`、`PATCH /api/admin/orders/:id` | 查看已付款订单。提交 `{"status":"ready"}` 或 `{"status":"picked"}` 推进状态。 |
| `GET /api/admin/print-jobs?orderId=…` | 查看制作单队列和状态。 |
| `POST /api/admin/orders/:id/reprint` | 按原取餐号生成补打任务。 |
| `GET /api/admin/links`、`GET /api/admin/qr?url=…` | 查询点餐链接或生成该链接的 PNG 二维码。链接响应中的 `publicUrl` 为当前公网点餐入口，`publicStatus` 标记临时地址验证状态（`checking`、`ready`、`unverified`）或预配地址（`configured`）。无公网入口时两项均为 `null`。 |

## 联调扩展点

| 模块 | 扩展位置与约定 |
| --- | --- |
| 门店码 | 管理接口按登录会话记录的门店 ID 生成二维码，顾客接口按链接中的 `store` 参数读取对应菜单。可配置 `PUBLIC_BASE_URL` 使用固定网址。 |
| 正式支付 | 在服务端替换 `paymentAdapter`，由支付渠道创建支付单并在服务端验证通知。验签后将订单 ID、实收分值、渠道流水号、支付时间传入 `server.mjs` 的 `recordConfirmedPayment`。真实接入时移除网页的模拟按钮及模拟支付路由。 |
| 云打印 | `printAdapter.createJob` 生成包含店铺 ID、取餐号、菜名、数量和备注的标签。接入时由服务端后台流程消费持久化任务，按门店配置选择联网打印机，调用厂商 API 后记录实际出票状态。自动出票按任务 ID 做幂等，人工补打创建独立任务并沿用原取餐号。 |

支付商户密钥、通知验签和打印机认证留在服务端。前端使用服务器返回的订单、付款状态和取餐号更新界面。
