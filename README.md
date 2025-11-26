# Backend cho Hệ thống Phê duyệt Kế hoạch bài dạy

Đây là một backend đơn giản được xây dựng bằng Node.js và Express, được thiết kế để hoạt động với frontend của Hệ thống Phê duyệt Kế hoạch bài dạy. Nó sử dụng một tệp `db.json` làm cơ sở dữ liệu để đảm bảo dữ liệu được lưu trữ bền vững, cho phép đầy đủ chức năng CRUD (Tạo, Đọc, Cập nhật, Xóa) mà không cần cài đặt một hệ quản trị cơ sở dữ liệu phức tạp.

## Yêu cầu
-   [Node.js](https://nodejs.org/) (phiên bản v16 trở lên được khuyến nghị)
-   npm (thường được cài đặt cùng với Node.js)

## Bắt đầu

Thực hiện các bước sau để chạy máy chủ backend trên máy của bạn.

### 1. Cài đặt các thư viện cần thiết

Mở terminal của bạn, di chuyển đến thư mục gốc của dự án, và chạy lệnh sau:

```bash
npm install
```

Lệnh này sẽ tải xuống và cài đặt tất cả các gói cần thiết được định nghĩa trong `package.json`, chẳng hạn như Express, CORS, và Multer.

### 2. Chạy môi trường phát triển (Frontend & Backend)

Sau khi cài đặt hoàn tất, bạn có thể khởi động cả hai máy chủ cùng lúc bằng một lệnh duy nhất:

```bash
npm run dev
```

Lệnh này sử dụng `concurrently` để chạy cả frontend (Vite) và backend (`nodemon`) cùng một lúc. `nodemon` sẽ tự động khởi động lại máy chủ backend mỗi khi bạn thay đổi mã nguồn.

### 3. Xác minh máy chủ đang chạy

Nếu thành công, bạn sẽ thấy các thông báo tương tự như sau trong terminal của mình:

```
[server] Backend server is running on http://localhost:3001
[vite]   VITE v5.x.x  ready in xxx ms
[vite]   ➜  Local:   http://localhost:5173/
```

Backend hiện đã chạy và sẵn sàng nhận các yêu cầu từ ứng dụng frontend.

## Cách hoạt động

-   **API Endpoint:** Tất cả các API đều có tiền tố `/api`. Ví dụ, dữ liệu khởi tạo có sẵn tại `http://localhost:3001/api/bootstrap`.
-   **Lưu trữ bằng `db.json`:** Máy chủ tải dữ liệu ban đầu từ `db.json`. Bất kỳ thay đổi nào bạn thực hiện (như thêm người dùng hoặc duyệt giáo án) sẽ được **ghi lại ngay lập tức** vào tệp `db.json`. Điều này đảm bảo rằng dữ liệu của bạn được lưu trữ bền vững và không bị mất khi khởi động lại máy chủ.
-   **Tự động tạo `db.json`:** Nếu tệp `db.json` không tồn tại khi bạn khởi động máy chủ lần đầu tiên, hệ thống sẽ tự động tạo một tệp mới với dữ liệu mẫu ban đầu.
-   **Tải tệp lên:** Các tệp giáo án được tải lên sẽ được lưu vào thư mục `uploads/`, thư mục này sẽ được tự động tạo trong thư mục gốc của dự án.
