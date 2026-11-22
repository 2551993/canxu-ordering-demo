# 点餐 Demo 接口

接口与网页同源。JSON 请求发送 `Content-Type: application/json`。金额使用整数分，失败返回 `{"error":{"code":"…","message":"…"}}`。商家工作台通过会话 Cookie 鉴权。首次注册、登录和查询会话可在未登录时调用。

## 扫码和顾客下单

| 路由 | 调用方式 |
| --- | --- |
| `GET /?store=window-shop` | 门店码落地页。二维码直接编码此页面的完整地址。 |
| `GET /api/store?store=window-shop` | 返回门店信息、分类与已上架餐品。 |
| `GET /api/queue?store=window-shop` | 返回 `{waitingCount}`，即已支付且处于 `preparing` 状态的订单数。 |
| `POST /api/orders` | 提交 `{"items":[{"itemId":"餐品ID","quantity":1}],"note":"少辣"}`。服务端按菜单重新计算金额并保存餐品快照，返回 `{order}`。 |
| `POST /api/orders/:id/pay` | 演示环境提交 `{}`，服务端确认模拟支付，生成数字取餐号和模拟制作单，返回 `{order}`。重复调用保留原取餐号和同一笔自动制作单。 |
| `GET /api/orders/:id` | 用不透明的订单 ID 查询详情。不要把短取餐号用作查询凭证。 |

订单包含 `id`、`shopId`、`shopName`、`items`、`totalCents`、`note`、`createdAt`、`paidAt`、`pickupNumber`、`paymentStatus`、`status` 和 `printStatus`。餐品快照包含名称、份数和单价。订单状态依次为 `pending`、`preparing`、`ready`、`picked`。

取餐号按支付时间的北京时间日期分配，从 `001` 到 `002` 依次递增。已有订单保留原号，分配时跳过当日已使用的号码。

## 商家工作台

| 路由 | 用途 |
| --- | --- |
| `GET /api/admin/session` | 返回 `{authenticated, registered, registrationAllowed}`，用于显示商家入口对应的注册、登录或工作台。 |
| `POST /api/admin/register` | 在本机首次注册。请求为 `{"phone":"13800138000","password":"…"}`，成功后建立商家会话。 |
| `POST /api/admin/login`、`POST /api/admin/logout` | 手机号和密码登录、退出。登录请求使用 `{"phone":"13800138000","password":"…"}`。 |
| `PUT /api/admin/password` | 登录后提交 `{"currentPassword":"…","newPassword":"…"}`。验证当前密码后更新密码，清除商家会话，并返回 `{authenticated:false,registered:true}`。 |
| `GET /api/admin/store`、`PUT /api/admin/shop` | 查询完整菜单及门店信息，更新 `name`、`announcement`、`address`。 |
| `POST /api/admin/categories`、`PUT /api/admin/categories/:id`、`DELETE /api/admin/categories/:id` | 新增、改名和删除分类。编辑字段为 `name`。 |
| `POST /api/admin/items`、`PUT /api/admin/items/:id`、`DELETE /api/admin/items/:id` | 维护餐品字段 `categoryId`、`name`、`priceCents`、`description`、`imageUrl`、`active`。 |
| `POST /api/admin/upload` | 提交 `{"dataUrl":"data:image/jpeg;base64,…"}`，返回 `{imageUrl}`。支持 PNG、JPEG、WebP，最多 2.5 MB。 |
| `GET /api/admin/orders`、`PATCH /api/admin/orders/:id` | 查看已付款订单。提交 `{"status":"ready"}` 或 `{"status":"picked"}` 推进状态。 |
| `GET /api/admin/print-jobs?orderId=…` | 查看制作单队列和状态。 |
| `POST /api/admin/orders/:id/reprint` | 按原取餐号生成补打任务。 |
| `GET /api/admin/links`、`GET /api/admin/qr?url=…` | 查询点餐链接或生成该链接的 PNG 二维码。 |

## 联调扩展点

| 模块 | 扩展位置与约定 |
| --- | --- |
| 门店码 | `lib/integrations.mjs` 的 `resolveStoreEntry` 解析 `store` 参数。正式渠道可以配置 `PUBLIC_BASE_URL` 继续复用门店落地链接。 |
| 正式支付 | 在服务端替换 `paymentAdapter`，由支付渠道创建支付单并在服务端验证通知。验签后将订单 ID、实收分值、渠道流水号、支付时间传入 `server.mjs` 的 `recordConfirmedPayment`。真实接入时移除网页的模拟按钮及模拟支付路由。 |
| 云打印 | `printAdapter.createJob` 生成包含店铺 ID、取餐号、菜名、数量和备注的标签。接入时由服务端后台流程消费持久化任务，按门店配置选择联网打印机，调用厂商 API 后记录实际出票状态。自动出票按任务 ID 做幂等，人工补打创建独立任务并沿用原取餐号。 |

支付商户密钥、通知验签和打印机认证留在服务端。前端使用服务器返回的订单、付款状态和取餐号更新界面。
