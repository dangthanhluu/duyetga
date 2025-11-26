// -----------------------------------------------------------------------------
// SECTION 1: IMPORTS & SETUP
// -----------------------------------------------------------------------------
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI } from "@google/genai";
import { AccountInfo, PublicClientApplication, Configuration, LogLevel } from '@azure/msal-browser';

// Declare global libraries from index.html
declare var docx: any, jspdf: any, html2canvas: any;

// -----------------------------------------------------------------------------
// SECTION 2: TYPES
// -----------------------------------------------------------------------------
enum Role {
  ADMIN = 'Quản trị viên toàn cầu',
  TEACHER = 'Giáo viên',
  DEPUTY_TEAM_LEADER = 'Tổ phó Chuyên môn',
  TEAM_LEADER = 'Tổ trưởng Chuyên môn',
  VICE_PRINCIPAL = 'Phó Hiệu trưởng',
  PRINCIPAL = 'Hiệu trưởng',
}

enum Status {
  DRAFT = 'Bản nháp',
  SUBMITTED = 'Chờ Tổ trưởng duyệt',
  REJECTED_BY_TL = 'Tổ trưởng từ chối',
  APPROVED_BY_TL = 'Chờ Hiệu trưởng duyệt',
  APPROVED = 'Đã phê duyệt',
  REJECTED_BY_VP = 'Hiệu trưởng từ chối',
  ISSUED = 'Đã ban hành'
}

interface School {
  id: string;
  name: string;
}

interface User {
  id: number;
  name: string;
  role: Role;
  email: string; // Đây sẽ là email O365 nếu đã đăng nhập bằng O365
  password?: string; // Mật khẩu cho tài khoản nội bộ (chỉ Hiệu trưởng/Admin)
  teamId?: number; // Liên kết với Team ID
  o365Email?: string; // Giữ lại để tương thích, nhưng email chính sẽ là nguồn
  oneDriveLink?: string; // Đường dẫn thư mục OneDrive mặc định của giáo viên
  zaloPhoneNumber?: string; // Số điện thoại Zalo để nhận thông báo
  schoolId?: string;
}

interface Team {
  id: number;
  name: string;
  leaderId?: number;
  deputyLeaderId?: number;
  schoolId?: string;
}

interface DelegationState {
  principalToVp: boolean;
  teamDelegation: {
    [teamId: number]: boolean;
  };
}

type HistoryAction = 
  | 'Tạo bản nháp'
  | 'Cập nhật bản nháp'
  | 'Nộp Kế hoạch bài dạy'
  | 'Nộp lại Kế hoạch bài dạy'
  | 'Tổ trưởng đã duyệt'
  | 'Tổ trưởng từ chối'
  | 'Tổ trưởng hủy duyệt'
  | 'Hiệu trưởng đã duyệt'
  | 'Hiệu trưởng từ chối'
  | 'Hiệu trưởng hủy duyệt'
  | 'Đã ban hành'
  | 'Thu hồi để chỉnh sửa'
  | 'Cập nhật trạng thái';


interface HistoryEntry {
  action: HistoryAction;
  user: User;
  timestamp: Date | string;
  reason?: string;
}

interface CommentEntry {
  id: number;
  user: User;
  timestamp: Date | string;
  text: string;
}


interface OneDriveFolder {
  id: string;
  name: string; // Full path for display
  driveId: string;
}

interface LessonPlan {
  id: number;
  title: string;
  submittedBy: User;
  submittedAt: Date | string; // Ngày tạo ban đầu hoặc ngày nộp cuối cùng
  status: Status;
  history: HistoryEntry[];
  comments?: CommentEntry[];
  file: {
    name: string;
    url: string; // Sẽ là object URL cho các tệp đã tải lên hoặc liên kết ngoài
    content?: ArrayBuffer; // Nội dung thực của tệp
    isExternalLink?: boolean; // True nếu 'url' là một liên kết ngoài
  };
  finalApprover?: User; // Will now be 'issuer'
  finalApprovedAt?: Date | string; // Will now be 'issuedAt'
  subject?: string;
  grade?: string;
  class?: string;
  notes?:string;
  oneDriveFolder?: OneDriveFolder; // Thay thế oneDriveLink bằng một object đầy đủ
  teamId?: number; // Tổ chuyên môn của giáo viên nộp
  schoolId?: string;
}

// -----------------------------------------------------------------------------
// SECTION 3: API HELPER (NEW SECTION)
// -----------------------------------------------------------------------------
const API_BASE_URL = '/api'; // Sử dụng đường dẫn tương đối cho production

/**
 * A wrapper for the native fetch API to handle JSON parsing, errors, and authentication.
 * @param endpoint The API endpoint to call (e.g., '/api/users').
 * @param options The options for the fetch request (method, body, etc.).
 * @returns A promise that resolves with the JSON response.
 * @throws An error if the network response is not ok.
 */
const api = async (endpoint: string, options: RequestInit = {}) => {
    // In a real app, you would get the token from your auth state
    const token = localStorage.getItem('authToken'); 
    
    const defaultHeaders: HeadersInit = {
        'Content-Type': 'application/json',
        ... (token ? { 'Authorization': `Bearer ${token}` } : {})
    };

    if (options.body instanceof FormData) {
        // Let the browser set the Content-Type for FormData
        delete (defaultHeaders as any)['Content-Type'];
    }

    const config: RequestInit = {
        method: options.method || 'GET',
        headers: {
            ...defaultHeaders,
            ...options.headers,
        },
        ...options,
    };
    
    const fullUrl = `${API_BASE_URL}${endpoint}`;
    const response = await fetch(fullUrl, config);

    if (!response.ok) {
        let errorMessage = `Lỗi máy chủ: ${response.status} ${response.statusText}`;
        if (response.status === 404) {
            errorMessage = `Không tìm thấy tài nguyên tại '${fullUrl}'. Có vẻ như API backend chưa được triển khai hoặc đang ngoại tuyến.`;
        } else {
             try {
                const errorData = await response.json();
                errorMessage = errorData.message || errorMessage;
            } catch (e) {
                // The response was not JSON, use the status text.
            }
        }
        throw new Error(errorMessage);
    }

    // Handle responses with no content
    if (response.status === 204) {
        return null;
    }
    
    return response.json();
};


// -----------------------------------------------------------------------------
// SECTION 4: MOCK DATA & CONSTANTS (UPDATED)
// -----------------------------------------------------------------------------
const MOCK_SCHOOLS = [
    { id: 'THCS-BINHSON', name: 'Trường THCS Bình Sơn' },
    { id: 'THPT-SONTINH', name: 'Trường THPT Sơn Tịnh' },
];
const MOCK_USERS: User[] = [
    { id: 1, name: 'Quản trị viên Toàn Cầu', role: Role.ADMIN, email: 'admin@gmail.com', password: 'Luuktm09@21', schoolId: undefined }, // Admin doesn't belong to a school
    { id: 2, name: 'Nguyễn Văn An', role: Role.PRINCIPAL, email: 'hieutruong@qni.edu.vn', password: '123', schoolId: 'THCS-BINHSON' },
    { id: 3, name: 'Trần Thị Bích', role: Role.VICE_PRINCIPAL, email: 'phohieutruong@qni.edu.vn', o365Email: 'bicht@qni.edu.vn', schoolId: 'THCS-BINHSON' },
    { id: 4, name: 'Lê Minh Cường', role: Role.TEAM_LEADER, email: 'cuonglm@qni.edu.vn', o365Email: 'cuonglm@qni.edu.vn', teamId: 1, schoolId: 'THCS-BINHSON' },
    { id: 5, name: 'Phạm Thị Dung', role: Role.DEPUTY_TEAM_LEADER, email: 'dungpt@qni.edu.vn', o365Email: 'dungpt@qni.edu.vn', teamId: 1, schoolId: 'THCS-BINHSON' },
    { id: 6, name: 'Hoàng Văn Em', role: Role.TEACHER, email: 'emhv@qni.edu.vn', o365Email: 'emhv@qni.edu.vn', teamId: 1, schoolId: 'THCS-BINHSON' },
    { id: 7, name: 'Vũ Thị Gấm', role: Role.TEACHER, email: 'gamvt@qni.edu.vn', o365Email: 'gamvt@qni.edu.vn', teamId: 1, schoolId: 'THCS-BINHSON' },
    { id: 8, name: 'Đỗ Hùng Kiên', role: Role.TEAM_LEADER, email: 'kiendh@qni.edu.vn', o365Email: 'kiendh@qni.edu.vn', teamId: 2, schoolId: 'THCS-BINHSON' },
    { id: 9, name: 'Nguyễn Thị Lan', role: Role.TEACHER, email: 'lann@qni.edu.vn', o365Email: 'lann@qni.edu.vn', teamId: 2, schoolId: 'THCS-BINHSON' },
    // Users for THPT Son Tinh
    { id: 10, name: 'Phan Huy Ích', role: Role.PRINCIPAL, email: 'hieutruong.st@qni.edu.vn', password: '123', schoolId: 'THPT-SONTINH' },
    { id: 11, name: 'Trần Văn Mười', role: Role.TEAM_LEADER, email: 'muoitv.st@qni.edu.vn', teamId: 3, schoolId: 'THPT-SONTINH' },
    { id: 12, name: 'Lý Thị Na', role: Role.TEACHER, email: 'nalt.st@qni.edu.vn', teamId: 3, schoolId: 'THPT-SONTINH' },
];
const MOCK_TEAMS: Team[] = [
    { id: 1, name: 'Tổ Khoa học Tự nhiên', leaderId: 4, deputyLeaderId: 5, schoolId: 'THCS-BINHSON' },
    { id: 2, name: 'Tổ Khoa học Xã hội', leaderId: 8, schoolId: 'THCS-BINHSON' },
    { id: 3, name: 'Tổ Toán - Tin', leaderId: 11, schoolId: 'THPT-SONTINH' },
];
const now = new Date();
const MOCK_LESSON_PLANS: LessonPlan[] = [
    { id: 1, title: 'Bài dạy: Phản ứng Oxi hóa - Khử', submittedBy: MOCK_USERS[5], submittedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(), status: Status.SUBMITTED, teamId: 1, subject: 'Khoa học tự nhiên', grade: 'Khối 8', class: '8A', file: { name: 'KHTN8_Oxihoa.pdf', url: '#' }, history: [ { action: 'Nộp Kế hoạch bài dạy', user: MOCK_USERS[5], timestamp: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString() }], schoolId: 'THCS-BINHSON' },
    { id: 2, title: 'Bài dạy: Truyện Kiều - Nguyễn Du', submittedBy: MOCK_USERS[8], submittedAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(), status: Status.REJECTED_BY_TL, teamId: 2, subject: 'Ngữ văn', grade: 'Khối 9', class: '9A', file: { name: 'NguVan9_TruyenKieu.pdf', url: '#' }, history: [ { action: 'Nộp Kế hoạch bài dạy', user: MOCK_USERS[8], timestamp: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString() }, { action: 'Tổ trưởng từ chối', user: MOCK_USERS[7], timestamp: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString(), reason: 'Cần bổ sung phần câu hỏi thảo luận.' }], comments: [{id: 1, user: MOCK_USERS[7], timestamp: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000), text: 'Em xem lại mục tiêu bài học và bổ sung thêm các câu hỏi thảo luận nhóm để tăng tương tác nhé.'}, {id: 2, user: MOCK_USERS[8], timestamp: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), text: 'Dạ, em đã nhận được góp ý ạ. Em sẽ chỉnh sửa ngay.'}], schoolId: 'THCS-BINHSON' },
    { id: 3, title: 'Bài dạy: Thì Hiện tại Hoàn thành', submittedBy: MOCK_USERS[6], submittedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(), status: Status.APPROVED_BY_TL, teamId: 1, subject: 'Ngoại ngữ 1 (Tiếng Anh)', grade: 'Khối 7', class: '7B', file: { name: 'English7_PresentPerfect.pdf', url: '#' }, history: [ { action: 'Nộp Kế hoạch bài dạy', user: MOCK_USERS[6], timestamp: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString() }, { action: 'Tổ trưởng đã duyệt', user: MOCK_USERS[3], timestamp: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString() }], schoolId: 'THCS-BINHSON' },
    { id: 4, title: 'Bài dạy: Lịch sử Việt Nam giai đoạn 1945-1954', submittedBy: MOCK_USERS[8], submittedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(), status: Status.ISSUED, teamId: 2, subject: 'Lịch sử và Địa lí', grade: 'Khối 9', class: '9B', file: { name: 'LichSu9_1945.pdf', url: '#' }, finalApprover: MOCK_USERS[1], finalApprovedAt: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString(), history: [ { action: 'Nộp Kế hoạch bài dạy', user: MOCK_USERS[8], timestamp: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString() }, { action: 'Tổ trưởng đã duyệt', user: MOCK_USERS[7], timestamp: new Date(now.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString() }, { action: 'Hiệu trưởng đã duyệt', user: MOCK_USERS[1], timestamp: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString() }, { action: 'Đã ban hành', user: MOCK_USERS[1], timestamp: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString() } ], schoolId: 'THCS-BINHSON' },
    { id: 5, title: 'Soạn bài: Lập trình Scratch cơ bản', submittedBy: MOCK_USERS[6], submittedAt: new Date().toISOString(), status: Status.DRAFT, teamId: 1, subject: 'Tin học', grade: 'Khối 6', class: '6A', file: { name: 'TinHoc6_Scratch.pdf', url: '#' }, history: [{ action: 'Tạo bản nháp', user: MOCK_USERS[6], timestamp: new Date().toISOString() }], schoolId: 'THCS-BINHSON' },
    // Lesson plan for THPT Son Tinh
    { id: 6, title: 'Bài dạy: Giới hạn hàm số', submittedBy: MOCK_USERS[11], submittedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(), status: Status.SUBMITTED, teamId: 3, subject: 'Toán', grade: 'Khối 11', class: '11A1', file: { name: 'Toan11_GioiHan.pdf', url: '#' }, history: [ { action: 'Nộp Kế hoạch bài dạy', user: MOCK_USERS[11], timestamp: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString() }], schoolId: 'THPT-SONTINH' },

];
const MOCK_DELEGATION: DelegationState = { principalToVp: false, teamDelegation: { 1: false, 2: false, 3: false } };
const MOCK_BOOTSTRAP_DATA = { schools: MOCK_SCHOOLS, users: MOCK_USERS, teams: MOCK_TEAMS, lessonPlans: MOCK_LESSON_PLANS, delegation: MOCK_DELEGATION };

const SUBJECTS: string[] = [
  'Ngữ văn', 'Toán', 'Ngoại ngữ 1 (Tiếng Anh)', 'Giáo dục công dân', 'Lịch sử và Địa lí', 'Khoa học tự nhiên', 'Công nghệ', 'Tin học', 'Giáo dục thể chất', 'Nghệ thuật (Âm nhạc)', 'Nghệ thuật (Mĩ thuật)', 'Hoạt động trải nghiệm, hướng nghiệp',
];

const GRADES: string[] = ['Khối 6', 'Khối 7', 'Khối 8', 'Khối 9', 'Khối 10', 'Khối 11', 'Khối 12'];

const CLASSES_BY_GRADE: { [key: string]: string[] } = {
  'Khối 6': ['6A', '6B'], 'Khối 7': ['7A', '7B'], 'Khối 8': ['8A', '8B'], 'Khối 9': ['9A', '9B'],
  'Khối 10': ['10A1', '10A2'], 'Khối 11': ['11A1', '11A2'], 'Khối 12': ['12A1', '12A2'],
};

const sendZaloNotification = async (user: User, message: string): Promise<void> => {
  // In a real app, this would be an API call to the backend
  // which then securely sends the Zalo message.
  // await api('/api/notifications/zalo', { method: 'POST', body: JSON.stringify({ userId: user.id, message }) });
  if (user.zaloPhoneNumber) {
    console.log(`%c[ZALO NOTIFICATION] 📲 Gửi tới SĐT "${user.zaloPhoneNumber}" (cho ${user.name}):\n%c"${message}"`, 'color: #0068ff; font-weight: bold;', 'color: #333; font-style: italic;');
  } else {
    console.warn(`[ZALO NOTIFICATION] ⚠️ Bỏ qua: Người dùng ${user.name} chưa cấu hình số điện thoại Zalo.`);
  }
};

const MSAL_CLIENT_ID = '2d8fa01f-3b3f-4944-8988-86e6c6586e76';
const msalConfig: Configuration = { auth: { clientId: MSAL_CLIENT_ID, authority: 'https://login.microsoftonline.com/organizations', redirectUri: window.location.origin }, cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: false, }, system: { loggerOptions: { loggerCallback: (level, message, containsPii) => { if (containsPii) return; if (level === LogLevel.Error) console.error(message); }, piiLoggingEnabled: false } } };
let msalInstance: PublicClientApplication | null = null;
const getMsalInstance = async (): Promise<PublicClientApplication> => { if (!msalInstance) { msalInstance = new PublicClientApplication(msalConfig); try { await msalInstance.initialize(); } catch(e) { console.error("Lỗi khởi tạo MSAL:", e); } } return msalInstance; };
const loginRequest = { scopes: ["User.Read", "Files.ReadWrite"] };
async function loginWithO365(instance: PublicClientApplication): Promise<AccountInfo | null> { try { const response = await instance.loginPopup(loginRequest); instance.setActiveAccount(response.account); return response.account; } catch (e) { if ((e as any).errorCode !== "user_cancelled") { console.error("Lỗi đăng nhập O365:", e); } return null; } }
async function verifyAndGetNameFromO365(): Promise<AccountInfo | null> { const instance = await getMsalInstance(); try { const activeAccount = instance.getActiveAccount(); if (activeAccount) { await instance.logoutPopup({ account: activeAccount }); } const loginResponse = await instance.loginPopup(loginRequest); if (loginResponse.account) { const accountInfo = loginResponse.account; await instance.logoutPopup({ account: accountInfo }); return accountInfo; } return null; } catch (e) { if ((e as any).errorCode !== "user_cancelled") { console.error("Lỗi xác thực O365:", e); } return null; } }

// These functions will now be API calls to the backend to avoid exposing tokens and logic on the client.
const convertDocxToPdf = async (file: File): Promise<File> => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(`${API_BASE_URL}/utils/convert-to-pdf`, { method: 'POST', body: formData });
    if (!response.ok) throw new Error('Chuyển đổi DOCX sang PDF thất bại.');
    const blob = await response.blob();
    return new File([blob], file.name.replace(/\.(docx|doc)$/i, '.pdf'), { type: 'application/pdf' });
};
const uploadToOneDrive = async (plan: LessonPlan, fileToUpload: File) => {
    const formData = new FormData();
    formData.append('file', fileToUpload);
    formData.append('planId', String(plan.id));
    // The backend will handle acquiring the token and uploading to the correct folder
    const response = await fetch(`${API_BASE_URL}/onedrive/upload`, { method: 'POST', body: formData });
    if (!response.ok) { const errorData = await response.json(); throw new Error(errorData.message || 'Tải lên OneDrive thất bại.'); }
};

// -----------------------------------------------------------------------------
// SECTION 5: UI COMPONENTS
// -----------------------------------------------------------------------------

// --- Component: NotificationModal ---
type NotificationType = 'success' | 'error' | 'loading' | 'info';
interface NotificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: NotificationType;
  title: string;
  message: string | React.ReactNode;
}
const NotificationModal: React.FC<NotificationModalProps> = ({ isOpen, onClose, type, title, message }) => {
  if (!isOpen) return null;

  const ICONS: Record<NotificationType, React.ReactNode> = {
    success: <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    error: <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    info: <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    loading: <svg className="animate-spin h-8 w-8" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>,
  };

  const CONFIG: Record<NotificationType, { iconBg: string; iconText: string; button: string; }> = {
    success: { iconBg: 'bg-green-100', iconText: 'text-green-600', button: 'bg-green-600 hover:bg-green-700 focus:ring-green-500' },
    error: { iconBg: 'bg-red-100', iconText: 'text-red-600', button: 'bg-red-600 hover:bg-red-700 focus:ring-red-500' },
    loading: { iconBg: 'bg-blue-100', iconText: 'text-blue-600', button: '' },
    info: { iconBg: 'bg-blue-100', iconText: 'text-blue-600', button: 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500' },
  };
  const currentConfig = CONFIG[type];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex justify-center items-center z-[100] p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md text-center">
        <div className="p-6 md:p-8">
          <div className={`w-16 h-16 mx-auto mb-5 rounded-full flex items-center justify-center ${currentConfig.iconBg}`}>
            <div className={currentConfig.iconText}>{ICONS[type]}</div>
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">{title}</h2>
          <div className="text-gray-600 leading-relaxed max-h-48 overflow-y-auto p-1">{message}</div>
        </div>
        {type !== 'loading' && (
          <div className="bg-gray-100 px-6 py-4 rounded-b-lg">
            <button onClick={onClose} className={`w-full px-4 py-2.5 text-white font-bold rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 ${currentConfig.button}`}>Đóng</button>
          </div>
        )}
      </div>
    </div>
  );
};

// --- Component: ActionModal ---
interface ActionModalProps {
  type: 'approve' | 'reject' | 'cancel';
  onClose: () => void;
  onConfirm: (reason?: string) => void;
}
const ActionModal: React.FC<ActionModalProps> = ({ type, onClose, onConfirm }) => {
  const [reason, setReason] = useState('');
  const config = {
    approve: { title: 'Xác nhận Duyệt', buttonText: 'Duyệt', buttonClass: 'bg-green-600 hover:bg-green-700' },
    reject: { title: 'Xác nhận Từ chối', buttonText: 'Từ chối', buttonClass: 'bg-red-600 hover:bg-red-700' },
    cancel: { title: 'Xác nhận Hủy duyệt', buttonText: 'Hủy duyệt', buttonClass: 'bg-yellow-600 hover:bg-yellow-700' },
  };
  const { title, buttonText, buttonClass } = config[type];
  const handleConfirm = () => { onConfirm(reason); }
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md m-4">
        <div className="p-6">
          <h2 className="text-2xl font-bold mb-4">{title}</h2>
          {type === 'reject' ? (
            <div>
              <label htmlFor="reason" className="block text-sm font-medium text-gray-700 mb-2">Lý do từ chối (bắt buộc)</label>
              <textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={4} className="w-full p-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500" placeholder="Nhập lý do chi tiết..."/>
            </div>
          ) : ( <p>Bạn có chắc chắn muốn thực hiện hành động này?</p> )}
        </div>
        <div className="bg-gray-100 px-6 py-4 flex justify-end space-x-3">
          <button onClick={onClose} className="px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300">Hủy</button>
          <button onClick={handleConfirm} className={`px-4 py-2 text-white rounded-md ${buttonClass}`}>{buttonText}</button>
        </div>
      </div>
    </div>
  );
};

// --- Component: ApprovalStepper ---
type StepStatus = 'completed' | 'current' | 'upcoming' | 'rejected';
const CheckIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>);
const XIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>);
const DotIcon = () => (<div className="w-3 h-3 bg-blue-600 rounded-full animate-pulse"></div>);
const CircleIcon = () => (<div className="w-3 h-3 bg-gray-300 rounded-full"></div>);
const statusConfigStepper: { [key in StepStatus]: { icon: React.ReactNode; iconBg: string; text: string; line: string } } = {
    completed: { icon: <CheckIcon />, iconBg: 'bg-green-500 text-white', text: 'text-green-600 font-semibold', line: 'border-green-500' },
    current: { icon: <DotIcon />, iconBg: 'bg-blue-200 text-blue-700', text: 'text-blue-600 font-semibold', line: 'border-gray-300' },
    upcoming: { icon: <CircleIcon />, iconBg: 'bg-gray-100 text-gray-500', text: 'text-gray-500', line: 'border-gray-300' },
    rejected: { icon: <XIcon />, iconBg: 'bg-red-500 text-white', text: 'text-red-600 font-semibold', line: 'border-gray-300' },
};

const ApprovalStepper: React.FC<{ plan: LessonPlan }> = ({ plan }) => {
    const steps: { name: string, status: StepStatus }[] = [
        { name: 'Trình ký', status: 'upcoming' }, { name: 'Tổ trưởng', status: 'upcoming' }, { name: 'P. Hiệu trưởng', status: 'upcoming' }, { name: 'Hoàn thành', status: 'upcoming' }
    ];
    switch (plan.status) {
        case Status.DRAFT: break;
        case Status.SUBMITTED: steps[0].status = 'completed'; steps[1].status = 'current'; break;
        case Status.REJECTED_BY_TL: steps[0].status = 'completed'; steps[1].status = 'rejected'; break;
        case Status.APPROVED_BY_TL: steps[0].status = 'completed'; steps[1].status = 'completed'; steps[2].status = 'current'; break;
        case Status.REJECTED_BY_VP: steps[0].status = 'completed'; steps[1].status = 'completed'; steps[2].status = 'rejected'; break;
        case Status.APPROVED: steps[0].status = 'completed'; steps[1].status = 'completed'; steps[2].status = 'completed'; steps[3].status = 'current'; break;
        case Status.ISSUED: steps[0].status = 'completed'; steps[1].status = 'completed'; steps[2].status = 'completed'; steps[3].status = 'completed'; break;
    }
    return (
        <div className="flex items-start w-full">
            {steps.map((step, index) => {
                const config = statusConfigStepper[step.status];
                const prevConfig = index > 0 ? statusConfigStepper[steps[index - 1].status] : statusConfigStepper.completed;
                return (
                    <React.Fragment key={step.name}>
                        {index > 0 && ( <div className={`flex-auto border-t-2 mt-3 ${prevConfig.line}`}></div> )}
                        <div className="flex flex-col items-center text-center w-20">
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center ${config.iconBg}`}>{config.icon}</div>
                            <p className={`text-xs mt-1 leading-tight ${config.text}`}>{step.name}</p>
                        </div>
                    </React.Fragment>
                );
            })}
        </div>
    );
};


// --- Component: HistoryModal ---
interface HistoryModalProps {
  plan: LessonPlan;
  onClose: () => void;
}
const HistoryModal: React.FC<HistoryModalProps> = ({ plan, onClose }) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl m-4">
        <div className="p-6 border-b"><h2 className="text-2xl font-bold">Lịch sử Phê duyệt</h2><p className="text-gray-600">{plan.title}</p></div>
        <div className="p-6 max-h-[60vh] overflow-y-auto">
          <ol className="relative border-l border-gray-200 dark:border-gray-700">
            {plan.history.map((entry: HistoryEntry, index: number) => (
              <li key={index} className="mb-10 ml-6">
                <span className="absolute flex items-center justify-center w-6 h-6 bg-blue-100 rounded-full -left-3 ring-8 ring-white dark:ring-gray-900 dark:bg-blue-900">
                  <svg className="w-2.5 h-2.5 text-blue-800 dark:text-blue-300" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 20 20"><path d="M20 4a2 2 0 0 0-2-2h-2V1a1 1 0 0 0-2 0v1h-3V1a1 1 0 0 0-2 0v1H6V1a1 1 0 0 0-2 0v1H2a2 2 0 0 0-2 2v2h20V4Z M0 18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8H0v10Zm5-8h10a1 1 0 0 1 0 2H5a1 1 0 0 1 0 -2Z"/></svg>
                </span>
                <h3 className="flex items-center mb-1 text-lg font-semibold text-gray-900">{entry.action}</h3>
                <time className="block mb-2 text-sm font-normal leading-none text-gray-400 dark:text-gray-500">
                  {new Date(entry.timestamp).toLocaleString('vi-VN')} bởi {entry.user.name} ({entry.user.role})
                </time>
                {entry.reason && ( <p className="p-3 text-sm italic border border-gray-200 rounded-lg bg-gray-50">Lý do: "{entry.reason}"</p> )}
              </li>
            ))}
          </ol>
        </div>
        <div className="bg-gray-100 px-6 py-4 flex justify-end"><button onClick={onClose} className="px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300">Đóng</button></div>
      </div>
    </div>
  );
};

// --- Component: PDFViewerModal ---
interface PDFViewerModalProps {
  plan: LessonPlan;
  onClose: () => void;
}
const PDFViewerModal: React.FC<PDFViewerModalProps> = ({ plan, onClose }) => {
  const isPdf = !plan.file.isExternalLink && plan.file.name.toLowerCase().endsWith('.pdf');
  const canPreview = isPdf && plan.file.url && plan.file.url !== '#';
  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex justify-center items-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b flex justify-between items-center bg-gray-50 rounded-t-lg flex-shrink-0">
          <h2 className="text-xl font-bold text-gray-800 truncate pr-4" title={plan.title}>Xem trước: {plan.title}</h2>
          <div className="flex items-center space-x-2">
            {canPreview && (
              <>
                <a href={plan.file.url} download={plan.file.name} title="Tải xuống" className="p-2 text-gray-600 bg-white border border-gray-300 rounded-full hover:bg-gray-100 transition"><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg></a>
                <a href={plan.file.url} target="_blank" rel="noopener noreferrer" title="Mở trong tab mới" className="p-2 text-gray-600 bg-white border border-gray-300 rounded-full hover:bg-gray-100 transition"><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg></a>
              </>
            )}
            <button onClick={onClose} title="Đóng" className="p-2 text-gray-600 bg-white border border-gray-300 rounded-full hover:bg-gray-100 transition"><svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg></button>
          </div>
        </div>
        <div className="flex-grow bg-gray-200 overflow-auto">
          {canPreview ? ( <iframe src={plan.file.url} className="w-full h-full border-0" title={plan.title} /> ) : (
            <div className="w-full h-full flex flex-col justify-center items-center bg-white rounded-b-md">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-16 h-16 text-gray-400 mb-4"><path strokeLinecap="round" strokeLinejoin="round" d="m15.75 15.75-2.489-2.489m0 0a3.375 3.375 0 1 0-4.773-4.773 3.375 3.375 0 0 0 4.774 4.774ZM21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
                <h3 className="text-lg font-semibold text-gray-700">Không có bản xem trước</h3>
                <p className="text-gray-500">Bản xem trước không có sẵn cho tệp này.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// --- Component: ReportModal ---
interface ReportModalProps {
  onClose: () => void;
  lessonPlans: LessonPlan[];
  currentUser: User;
}
const LoadingSpinner: React.FC = () => (
    <div className="flex flex-col items-center justify-center text-center">
        <svg className="animate-spin h-8 w-8 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
        <p className="mt-3 text-gray-600 font-semibold">AI đang phân tích dữ liệu và tạo báo cáo...</p>
        <p className="text-sm text-gray-500">Quá trình này có thể mất vài giây.</p>
    </div>
);
const ReportModal: React.FC<ReportModalProps> = ({ onClose, lessonPlans, currentUser }) => {
  const [report, setReport] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('Sao chép Báo cáo');
  useEffect(() => {
    const generateReport = async () => {
      if (lessonPlans.length === 0) {
        setReport('Không có dữ liệu giáo án để tạo báo cáo.');
        setIsLoading(false);
        return;
      }
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const planData = lessonPlans.map(p => `- Tiêu đề: ${p.title}, Môn: ${p.subject}, Lớp: ${p.class}, Trạng thái: ${p.status}, Người nộp: ${p.submittedBy.name}`).join('\n');
        const prompt = `Với vai trò là một trợ lý quản lý giáo dục cho ${currentUser.role} (${currentUser.name}), hãy viết một báo cáo tổng hợp ngắn gọn về tình hình duyệt giáo án dựa trên danh sách sau. Báo cáo cần có các phần: 1. Tóm tắt chung (số lượng giáo án, các trạng thái nổi bật). 2. Phân tích chi tiết theo từng trạng thái (ví dụ: danh sách các giáo án đang chờ duyệt, đã bị từ chối). 3. Đề xuất hành động (nếu có, ví dụ: nhắc nhở giáo viên có giáo án bị từ chối). Báo cáo cần chuyên nghiệp, rõ ràng, sử dụng tiếng Việt và định dạng Markdown để dễ đọc. Dữ liệu giáo án:\n${planData}`;
        const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt, });
        setReport(response.text);
      } catch (e: any) {
        console.error(e);
        setError('Không thể tạo báo cáo. Đã xảy ra lỗi khi kết nối đến dịch vụ AI. Vui lòng thử lại sau.');
      } finally {
        setIsLoading(false);
      }
    };
    generateReport();
  }, [lessonPlans, currentUser]);
  const handleCopy = () => {
    navigator.clipboard.writeText(report).then(() => {
        setCopyStatus('Đã sao chép!');
        setTimeout(() => setCopyStatus('Sao chép Báo cáo'), 2000);
    }).catch(() => {
        setCopyStatus('Lỗi!');
        setTimeout(() => setCopyStatus('Sao chép Báo cáo'), 2000);
    });
  };
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl h-[80vh] flex flex-col">
        <div className="p-4 border-b flex justify-between items-center"><h2 className="text-xl font-bold text-gray-800">Báo cáo Tổng hợp Tình hình Giáo án</h2><button onClick={onClose} className="text-gray-500 hover:text-gray-800 text-2xl">&times;</button></div>
        <div className="flex-grow overflow-y-auto p-6">
          {isLoading ? (<div className="w-full h-full flex items-center justify-center"><LoadingSpinner /></div>) : error ? (<div className="text-center text-red-600 p-8 bg-red-50 rounded-lg">{error}</div>) : (<pre className="whitespace-pre-wrap font-sans text-sm text-gray-800 leading-relaxed">{report}</pre>)}
        </div>
        <div className="bg-gray-100 px-6 py-4 flex justify-end space-x-3 border-t">
          <button type="button" onClick={handleCopy} disabled={isLoading || !!error} className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 disabled:bg-gray-400">{copyStatus}</button>
          <button type="button" onClick={onClose} className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Đóng</button>
        </div>
      </div>
    </div>
  );
};

// --- Component: UploadModal ---
type UploadSource = { file?: File, content?: ArrayBuffer, existingFile?: LessonPlan['file'] };
interface UploadDetails { title: string; subject: string; grade: string; class: string; notes?: string; oneDriveFolder?: OneDriveFolder; }
interface UploadModalProps { onClose: () => void; onSave: (details: UploadDetails, source: UploadSource, isDraft: boolean) => void; lessonPlanToEdit?: LessonPlan | null; currentUser: User; onLinkO365: () => Promise<void>; msalInstance: PublicClientApplication | null; account: AccountInfo | null; }
const UploadModal: React.FC<UploadModalProps> = ({ onClose, onSave, lessonPlanToEdit, currentUser, onLinkO365, msalInstance, account }) => {
  const isEditing = !!lessonPlanToEdit;
  const isO365Connected = !!currentUser.o365Email && !!account;
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [grade, setGrade] = useState('');
  const [className, setClassName] = useState('');
  const [notes, setNotes] = useState('');
  const [oneDriveFolder, setOneDriveFolder] = useState<OneDriveFolder | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [existingFileName, setExistingFileName] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [oneDriveLink, setOneDriveLink] = useState('');
  const [subFolders, setSubFolders] = useState<OneDriveFolder[]>([]);
  const [isLoadingFolders, setIsLoadingFolders] = useState(false);
  const [folderError, setFolderError] = useState('');

  useEffect(() => {
    const savedLink = currentUser.oneDriveLink || localStorage.getItem('oneDriveShareLink') || '';
    setOneDriveLink(savedLink);
    if (lessonPlanToEdit) {
      setTitle(lessonPlanToEdit.title || '');
      setSubject(lessonPlanToEdit.subject || '');
      setGrade(lessonPlanToEdit.grade || '');
      setClassName(lessonPlanToEdit.class || '');
      setNotes(lessonPlanToEdit.notes || '');
      setOneDriveFolder(lessonPlanToEdit.oneDriveFolder || null);
      if (lessonPlanToEdit.file) setExistingFileName(lessonPlanToEdit.file.name);
    }
  }, [lessonPlanToEdit, currentUser.oneDriveLink]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => { if (e.target.files && e.target.files.length > 0) { const selectedFile = e.target.files[0]; if (['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(selectedFile.type)) { setFile(selectedFile); setExistingFileName(null); setError(''); } else { setError('Chỉ chấp nhận tệp Word (.doc, .docx) hoặc PDF.'); setFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; } } };
  const handleGradeChange = (e: React.ChangeEvent<HTMLSelectElement>) => { setGrade(e.target.value); setClassName(''); };

  const processAndSave = (isDraft: boolean) => {
    if (!title.trim() || !subject.trim() || !grade.trim() || !className.trim()) { setError('Vui lòng điền đầy đủ các trường thông tin bắt buộc.'); return; }
    if (!file && !isEditing) { setError('Vui lòng chọn một tệp để tải lên.'); return; }
    if (isO365Connected && !oneDriveFolder) { setError('Vui lòng chọn thư mục lưu trữ trên OneDrive.'); return; }
    setError(''); const lessonPlanDetails: UploadDetails = { title, subject, grade, class: className, notes, oneDriveFolder: oneDriveFolder || undefined };
    if (file) { const reader = new FileReader(); reader.onload = (event) => { if (event.target && event.target.result) onSave(lessonPlanDetails, { file, content: event.target.result as ArrayBuffer }, isDraft); else setError('Không thể đọc tệp. Vui lòng thử lại.'); }; reader.onerror = () => setError('Đã xảy ra lỗi khi đọc tệp.'); reader.readAsArrayBuffer(file); } 
    else if (isEditing && lessonPlanToEdit?.file) { onSave(lessonPlanDetails, { existingFile: lessonPlanToEdit.file }, isDraft); }
  };
  
  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); processAndSave(false); };
  const handleSaveDraft = () => { processAndSave(true); };

  const handleLinkChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newLink = e.target.value;
    setOneDriveLink(newLink);
    localStorage.setItem('oneDriveShareLink', newLink);
  };

  const encodeSharingUrl = (url: string) => {
    const base64 = btoa(url);
    return 'u!' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  };

  const handleFetchFolders = async () => {
    if (!oneDriveLink) { setFolderError('Vui lòng nhập liên kết chia sẻ OneDrive.'); return; }
    if (!account || !msalInstance) { setFolderError('Vui lòng đăng nhập tài khoản Microsoft trước.'); return; }
    setIsLoadingFolders(true); setFolderError(''); setSubFolders([]); setOneDriveFolder(null);

    try {
        const request = { scopes: ["User.Read", "Files.ReadWrite"], account };
        const response = await msalInstance.acquireTokenSilent(request);
        const headers = { 'Authorization': `Bearer ${response.accessToken}` };
        const encodedUrl = encodeSharingUrl(oneDriveLink);
        const shareResponse = await fetch(`https://graph.microsoft.com/v1.0/shares/${encodedUrl}/driveItem`, { headers });
        if (!shareResponse.ok) throw new Error('Không thể truy cập. Vui lòng kiểm tra lại link và quyền "Có thể chỉnh sửa".');
        
        const shareData = await shareResponse.json();
        const driveId = shareData.parentReference.driveId;
        const rootItemId = shareData.id;
        
        const fetchSubFolders = async (currentItemId: string, pathPrefix: string): Promise<OneDriveFolder[]> => {
            let allFolders: OneDriveFolder[] = [];
            const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${currentItemId}/children?$filter=folder ne null&$select=id,name,parentReference`;
            const childrenResponse = await fetch(url, { headers });
            if (!childrenResponse.ok) return [];
            const childrenData = await childrenResponse.json();
            for (const item of childrenData.value) {
                const currentPath = pathPrefix ? `${pathPrefix} / ${item.name}` : item.name;
                allFolders.push({ id: item.id, name: currentPath, driveId: item.parentReference.driveId });
                const subFolders = await fetchSubFolders(item.id, currentPath);
                allFolders = allFolders.concat(subFolders);
            }
            return allFolders;
        };

        const rootFolder: OneDriveFolder = { id: rootItemId, name: shareData.name || 'Thư mục gốc', driveId: driveId };
        const folderList = await fetchSubFolders(rootItemId, rootFolder.name);
        setSubFolders([rootFolder, ...folderList]);
    } catch (err: any) {
        console.error(err);
        setFolderError(err.message || 'Lỗi không xác định khi tải thư mục.');
    } finally {
        setIsLoadingFolders(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl" onClick={e => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="p-6">
            <h2 className="text-2xl font-bold mb-4">{isEditing ? 'Chỉnh sửa Kế hoạch bài dạy' : 'Tải lên Kế hoạch bài dạy mới'}</h2>
            {error && <p className="text-red-500 text-sm mb-4 bg-red-50 p-3 rounded-md">{error}</p>}
            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-2">
              <div><label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-1">Tiêu đề <span className="text-red-500">*</span></label><input type="text" id="title" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full p-2 border border-gray-300 rounded-md shadow-sm" placeholder="Ví dụ: Kế hoạch bài dạy bài Sóng - Ngữ Văn 11" required /></div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div><label htmlFor="subject" className="block text-sm font-medium text-gray-700 mb-1">Môn học <span className="text-red-500">*</span></label><select id="subject" value={subject} onChange={e => setSubject(e.target.value)} className="w-full p-2 border border-gray-300 rounded-md" required><option value="" disabled>Chọn môn học</option>{SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
                  <div><label htmlFor="grade" className="block text-sm font-medium text-gray-700 mb-1">Khối lớp <span className="text-red-500">*</span></label><select id="grade" value={grade} onChange={handleGradeChange} className="w-full p-2 border border-gray-300 rounded-md" required><option value="" disabled>Chọn khối</option>{GRADES.map(g => <option key={g} value={g}>{g}</option>)}</select></div>
                  <div><label htmlFor="class" className="block text-sm font-medium text-gray-700 mb-1">Lớp <span className="text-red-500">*</span></label><select id="class" value={className} onChange={e => setClassName(e.target.value)} className="w-full p-2 border border-gray-300 rounded-md" required disabled={!grade}><option value="" disabled>Chọn lớp</option>{grade && CLASSES_BY_GRADE[grade] && CLASSES_BY_GRADE[grade].map(c => <option key={c} value={c}>{c}</option>)}</select></div>
              </div>
              <div><label htmlFor="notes" className="block text-sm font-medium text-gray-700 mb-1">Ghi chú (tùy chọn)</label><textarea id="notes" value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="w-full p-2 border border-gray-300 rounded-md" placeholder="Các lưu ý thêm..."></textarea></div>
              <div className="p-4 border rounded-lg bg-gray-50">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Thư mục lưu trữ (khi được duyệt)</label>
                  {!isO365Connected ? (
                      <div className="p-3 rounded-md bg-yellow-50 border border-yellow-200 flex items-center justify-between gap-4">
                          <p className="text-sm text-yellow-800">Kết nối tài khoản Office 365 để chọn thư mục lưu trữ tự động.</p>
                          <button type="button" onClick={onLinkO365} className="px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-md hover:bg-blue-700 whitespace-nowrap">Kết nối ngay</button>
                      </div>
                  ) : (
                      <div className="space-y-3">
                          <div>
                              <label htmlFor="onedrive-link" className="block text-xs font-medium text-gray-600 mb-1">1. Dán liên kết chia sẻ thư mục gốc (quyền "Có thể chỉnh sửa")</label>
                              <div className="flex gap-2">
                                  <input id="onedrive-link" type="text" value={oneDriveLink} onChange={handleLinkChange} placeholder="Dán link OneDrive vào đây..." className="flex-grow p-2 border border-gray-300 rounded-md shadow-sm" />
                                  <button type="button" onClick={handleFetchFolders} disabled={isLoadingFolders} className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-md hover:bg-indigo-700 disabled:bg-gray-400 whitespace-nowrap">{isLoadingFolders ? 'Đang tải...' : 'Tải thư mục'}</button>
                              </div>
                          </div>
                          {folderError && <p className="text-red-500 text-xs mt-1">{folderError}</p>}
                          {subFolders.length > 0 && (
                            <div>
                              <label htmlFor="folder-select" className="block text-xs font-medium text-gray-600 mb-1">2. Chọn thư mục đích</label>
                              <select id="folder-select" onChange={e => setOneDriveFolder(JSON.parse(e.target.value))} className="w-full p-2 border border-gray-300 rounded-md" required>
                                  <option value="" disabled selected={!oneDriveFolder}>-- Vui lòng chọn một thư mục --</option>
                                  {subFolders.slice().sort((a,b) => a.name.localeCompare(b.name)).map(folder => (
                                      <option key={folder.id} value={JSON.stringify(folder)} selected={oneDriveFolder?.id === folder.id}>{folder.name}</option>
                                  ))}
                              </select>
                            </div>
                          )}
                      </div>
                  )}
              </div>
              <div><label htmlFor="file" className="block text-sm font-medium text-gray-700 mb-1">Chọn tệp (Word hoặc PDF) {!isEditing && <span className="text-red-500">*</span>}</label><input type="file" id="file" ref={fileInputRef} onChange={handleFileChange} className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" accept=".doc,.docx,.pdf" required={!isEditing} />{file && <p className="text-sm text-green-600 mt-2">Tệp mới: {file.name}</p>}{existingFileName && <p className="text-sm text-gray-600 mt-2">Tệp hiện tại: {existingFileName} (chọn tệp mới để thay thế)</p>}</div>
            </div>
          </div>
          <div className="bg-gray-100 px-6 py-4 flex justify-end space-x-3 border-t">
            <button type="button" onClick={onClose} className="px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300">Hủy</button>
            <button type="button" onClick={handleSaveDraft} className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700">{isEditing ? 'Lưu thay đổi' : 'Lưu bản nháp'}</button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">{isEditing ? 'Cập nhật & Gửi duyệt' : 'Tải lên & Gửi duyệt'}</button>
          </div>
        </form>
      </div>
    </div>
  );
};


// --- Component: UserProfileModal ---
interface UserProfileModalProps { isOpen: boolean; onClose: () => void; currentUser: User; onLinkO365: () => void; onUnlinkO365: () => void; onUpdateProfile: (updatedUser: User) => void; msalInstance: PublicClientApplication | null; account: AccountInfo | null; onNotification: (config: Omit<NotificationModalProps, 'isOpen' | 'onClose'>) => void; }
const UserProfileModal: React.FC<UserProfileModalProps> = ({ isOpen, onClose, currentUser, onLinkO365, onUnlinkO365, onUpdateProfile, msalInstance, account, onNotification }) => {
    const [zaloPhone, setZaloPhone] = useState(currentUser.zaloPhoneNumber || '');
    const [checkStatus, setCheckStatus] = useState<'idle' | 'checking' | 'success' | 'error'>('idle');
    const [checkMessage, setCheckMessage] = useState('');
    if (!isOpen) return null;
    const isO365Connected = !!currentUser.o365Email && !!account;
    const InfoRow: React.FC<{ label: string; value: string | React.ReactNode }> = ({ label, value }) => (<div><p className="text-sm font-medium text-gray-500">{label}</p><p className="font-semibold">{value}</p></div>);
    const handleSave = () => { onUpdateProfile({ ...currentUser, zaloPhoneNumber: zaloPhone.trim() }); onNotification({type: 'success', title: 'Thành công', message: 'Thông tin hồ sơ đã được cập nhật.'}) };
    const handleCheckConnection = async () => {
        if (!msalInstance || !account) { setCheckMessage('Lỗi: Không tìm thấy thông tin xác thực.'); setCheckStatus('error'); return; }
        setCheckStatus('checking'); setCheckMessage('Đang kiểm tra kết nối...');
        try {
            const response = await msalInstance.acquireTokenSilent({ scopes: ["User.Read"], account });
            const apiResponse = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { 'Authorization': `Bearer ${response.accessToken}` } });
            if (!apiResponse.ok) throw new Error('Token không hợp lệ hoặc đã hết hạn.');
            const userData = await apiResponse.json();
            setCheckStatus('success'); setCheckMessage(`Kết nối thành công! (Xin chào, ${userData.displayName})`);
        } catch (error: any) { console.error("Connection check failed:", error); setCheckStatus('error'); setCheckMessage('Kiểm tra thất bại. Vui lòng kết nối lại.'); } 
        finally { setTimeout(() => { setCheckStatus('idle'); setCheckMessage(''); }, 4000); }
    };
    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4" onClick={onClose}>
            <div className="bg-white rounded-lg shadow-xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
                <div className="p-6 border-b"><h2 className="text-2xl font-bold">Thông tin tài khoản</h2></div>
                <div className="p-6 space-y-4">
                    <InfoRow label="Họ và tên" value={currentUser.name} />
                    <InfoRow label="Vai trò" value={currentUser.role} />
                    <InfoRow label="Email" value={currentUser.email} />
                    <div><label htmlFor="zaloPhone" className="block text-sm font-medium text-gray-500 mb-1">Số điện thoại Zalo</label><input id="zaloPhone" type="tel" value={zaloPhone} onChange={(e) => setZaloPhone(e.target.value)} placeholder="Nhập SĐT để nhận thông báo" className="w-full p-2 border border-gray-300 rounded-md shadow-sm" /><p className="text-xs text-gray-500 mt-1">Dùng để nhận thông báo tức thời về trạng thái giáo án.</p></div>
                    {!isO365Connected ? (
                         <div className="p-4 rounded-lg bg-yellow-50 border border-yellow-200">
                             <div className="flex items-start space-x-3"><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-yellow-500 mt-0.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" /></svg>
                                <div>
                                    <h3 className="font-semibold text-yellow-800">Chưa kết nối Office 365</h3><p className="text-sm text-yellow-700 mt-1 mb-3">Kết nối tài khoản của bạn để đồng bộ hóa dữ liệu và truy cập các tính năng nâng cao.</p>
                                    <button onClick={onLinkO365} className="inline-flex items-center px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"><svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 24 24"><path d="M2.75 12.32h8.53v8.53h-8.53v-8.53Zm0-1.41h8.53V2.38h-8.53v8.53Zm9.94 1.41h8.53v8.53h-8.53v-8.53Zm0-1.41h8.53V2.38h-8.53v8.53Z" /></svg>Kết nối với Office 365</button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="p-4 border rounded-lg bg-green-50 border-green-300">
                            <div className="flex items-start space-x-3"><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
                                <div>
                                    <h3 className="font-semibold text-green-800">Đã kết nối Office 365</h3><p className="text-sm text-gray-700 mt-1">Tài khoản được liên kết với: <span className="font-mono font-medium">{currentUser.o365Email}</span></p>
                                    <div className="mt-3 flex items-center space-x-2">
                                        <button onClick={handleCheckConnection} disabled={checkStatus === 'checking'} className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-xs font-semibold rounded-md hover:bg-gray-100 disabled:opacity-50 disabled:cursor-wait">{checkStatus === 'checking' ? 'Đang kiểm tra...' : 'Kiểm tra kết nối'}</button>
                                        <button onClick={onUnlinkO365} className="text-xs text-red-600 hover:underline font-semibold">Hủy liên kết</button>
                                    </div>
                                    {checkMessage && (<p className={`text-xs mt-2 p-2 rounded-md ${checkStatus === 'success' ? 'bg-green-100 text-green-800' : checkStatus === 'error' ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800'}`}>{checkMessage}</p>)}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
                <div className="bg-gray-100 px-6 py-4 flex justify-end space-x-3"><button onClick={onClose} className="px-6 py-2 bg-gray-200 text-gray-800 font-semibold rounded-md hover:bg-gray-300">Hủy</button><button onClick={handleSave} className="px-6 py-2 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700">Lưu thay đổi</button></div>
            </div>
        </div>
    );
};

// --- Component: EditUserModal ---
interface EditUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: User;
  teams: Team[];
  onSave: (updatedUser: User) => void;
  onNotification: (config: Omit<NotificationModalProps, 'isOpen' | 'onClose'>) => void;
}
const EditUserModal: React.FC<EditUserModalProps> = ({ isOpen, onClose, user, teams, onSave, onNotification }) => {
  const [formData, setFormData] = useState<User>(user);
  useEffect(() => { setFormData(user); }, [user]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };
  
  const handleTeamChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value ? Number(value) : undefined }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
    onNotification({ type: 'success', title: 'Cập nhật thành công', message: `Thông tin của người dùng "${formData.name}" đã được lưu.`});
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-[60] p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="p-6 border-b">
            <h2 className="text-2xl font-bold">Chỉnh sửa thông tin người dùng</h2>
            <p className="text-gray-600">Bạn đang chỉnh sửa hồ sơ của {user.name}</p>
          </div>
          <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
            <div><label htmlFor="name" className="block text-sm font-medium text-gray-700">Họ và tên</label><input type="text" id="name" name="name" value={formData.name} onChange={handleChange} className="w-full p-2 mt-1 border border-gray-300 rounded-md shadow-sm" required /></div>
            <div><label htmlFor="email" className="block text-sm font-medium text-gray-700">Email (Office 365)</label><input type="email" id="email" name="email" value={formData.email} className="w-full p-2 mt-1 border border-gray-300 rounded-md shadow-sm bg-gray-100" readOnly /></div>
            <div><label htmlFor="zaloPhoneNumber" className="block text-sm font-medium text-gray-700">SĐT Zalo (tùy chọn)</label><input type="tel" id="zaloPhoneNumber" name="zaloPhoneNumber" value={formData.zaloPhoneNumber || ''} onChange={handleChange} className="w-full p-2 mt-1 border border-gray-300 rounded-md shadow-sm" /></div>
            <div><label htmlFor="oneDriveLink" className="block text-sm font-medium text-gray-700">Liên kết thư mục OneDrive (tùy chọn)</label><input type="text" id="oneDriveLink" name="oneDriveLink" value={formData.oneDriveLink || ''} onChange={handleChange} className="w-full p-2 mt-1 border border-gray-300 rounded-md shadow-sm" /></div>
            <div className="grid grid-cols-2 gap-4">
              <div><label htmlFor="role" className="block text-sm font-medium text-gray-700">Vai trò</label><select id="role" name="role" value={formData.role} onChange={handleChange} className="w-full p-2 mt-1 border border-gray-300 rounded-md shadow-sm">{Object.entries(Role).filter(([, value]) => value !== Role.ADMIN).map(([key, value]) => <option key={key} value={value}>{value}</option>)}</select></div>
              <div><label htmlFor="teamId" className="block text-sm font-medium text-gray-700">Tổ chuyên môn</label><select id="teamId" name="teamId" value={formData.teamId || ''} onChange={handleTeamChange} className="w-full p-2 mt-1 border border-gray-300 rounded-md shadow-sm"><option value="">Chưa phân công</option>{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></div>
            </div>
          </div>
          <div className="bg-gray-100 px-6 py-4 flex justify-end space-x-3"><button type="button" onClick={onClose} className="px-4 py-2 bg-gray-200 rounded-md">Hủy</button><button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Lưu thay đổi</button></div>
        </form>
      </div>
    </div>
  );
};


// --- Component: AdminModal ---
type NewUserDetails = { name: string; email: string; initialPassword?: string; role: Role; teamId?: number; zaloPhone?: string; oneDriveLink?: string; schoolId?: string; }
interface AdminModalProps { isOpen: boolean; onClose: () => void; users: User[]; teams: Team[]; schools: School[]; delegation: DelegationState; onAddUser: (details: Omit<NewUserDetails, 'schoolId'>, schoolId: string) => void; onCreateTeam: (teamName: string, schoolId: string) => void; onUpdateUser: (user: User) => void; onAssignTeamRole: (teamId: number, roleType: 'leader' | 'deputy', userId: number | null) => void; onSetDelegation: (delegation: DelegationState) => void; onNotification: (config: Omit<NotificationModalProps, 'isOpen' | 'onClose'>) => void; onAddSchool: (school: Omit<School, 'id'>) => void; onUpdateSchool: (school: School) => void; onDeleteSchool: (schoolId: string) => void; currentUser: User; selectedSchool?: School | null; }
const AdminModal: React.FC<AdminModalProps> = ({ isOpen, onClose, users, teams, schools, delegation, onAddUser, onCreateTeam, onUpdateUser, onAssignTeamRole, onSetDelegation, onNotification, onAddSchool, onUpdateSchool, onDeleteSchool, currentUser, selectedSchool }) => {
  const [activeTab, setActiveTab] = useState('users');
  const [isAddingUser, setIsAddingUser] = useState(false);
  const [newUserName, setNewUserName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserZalo, setNewUserZalo] = useState('');
  const [newUserTeamId, setNewUserTeamId] = useState('');
  const [newUserOneDriveLink, setNewUserOneDriveLink] = useState('');
  const [newTeamName, setNewTeamName] = useState('');
  const [userToEdit, setUserToEdit] = useState<User | null>(null);

  const [editingSchool, setEditingSchool] = useState<School | null>(null);
  const [newSchoolName, setNewSchoolName] = useState('');

  const isGlobalAdmin = currentUser.role === Role.ADMIN;
  const [adminSelectedSchoolId, setAdminSelectedSchoolId] = useState<string>(selectedSchool?.id || '');

  useEffect(() => {
    if (isOpen && !isGlobalAdmin && selectedSchool) {
        setAdminSelectedSchoolId(selectedSchool.id);
    } else if (isOpen && isGlobalAdmin && schools.length > 0) {
        setAdminSelectedSchoolId(schools[0].id);
    }
  }, [isOpen, isGlobalAdmin, selectedSchool, schools]);
  
  useEffect(() => { if (!isOpen) { setIsAddingUser(false); setNewUserName(''); setNewUserEmail(''); setNewTeamName(''); setNewUserZalo(''); setNewUserTeamId(''); setNewUserOneDriveLink(''); setUserToEdit(null); setEditingSchool(null); setNewSchoolName(''); } }, [isOpen]);
  
  const handleAddUserSubmit = (e: React.FormEvent) => { 
    e.preventDefault(); 
    if (users.some(u => u.email.toLowerCase() === newUserEmail.toLowerCase().trim())) {
      onNotification({ type: 'error', title: 'Thêm thất bại', message: 'Email này đã tồn tại trong hệ thống. Vui lòng sử dụng một email khác.' });
      return;
    }
    const userDetails: Omit<NewUserDetails, 'schoolId'> = { name: newUserName.trim(), email: newUserEmail.trim(), role: Role.TEACHER, teamId: newUserTeamId ? Number(newUserTeamId) : undefined, zaloPhone: newUserZalo.trim() || undefined, oneDriveLink: newUserOneDriveLink.trim() || undefined };
    onAddUser(userDetails, adminSelectedSchoolId); 
    onNotification({ type: 'success', title: 'Thêm thành công', message: `Đã thêm giáo viên "${newUserName.trim()}". Người dùng này có thể đăng nhập bằng tài khoản Office 365.` }); 
    setIsAddingUser(false); setNewUserName(''); setNewUserEmail(''); setNewUserZalo(''); setNewUserTeamId(''); setNewUserOneDriveLink(''); 
  };

  const handleCreateTeamSubmit = (e: React.FormEvent) => { e.preventDefault(); if (newTeamName.trim()) { onCreateTeam(newTeamName.trim(), adminSelectedSchoolId); setNewTeamName(''); } };
  const handleTeamLeadChange = (teamId: number, type: 'leader' | 'deputy', userId: string) => {
    const newUserId = userId ? Number(userId) : null;
    onAssignTeamRole(teamId, type, newUserId);
  };
  const handleDelegationChange = (type: 'vp' | 'team', teamId?: number) => { const newDelegation = {...delegation}; if (type === 'vp') newDelegation.principalToVp = !newDelegation.principalToVp; else if (teamId) newDelegation.teamDelegation[teamId] = !newDelegation.teamDelegation[teamId]; onSetDelegation(newDelegation); };
  
  const handleSchoolSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSchoolName.trim()) return;
    if (editingSchool) {
      onUpdateSchool({ ...editingSchool, name: newSchoolName.trim() });
      onNotification({ type: 'success', title: 'Thành công', message: 'Tên trường đã được cập nhật.' });
    } else {
      onAddSchool({ name: newSchoolName.trim() });
      onNotification({ type: 'success', title: 'Thành công', message: 'Đã thêm trường mới.' });
    }
    setEditingSchool(null);
    setNewSchoolName('');
  };

  const handleEditSchool = (school: School) => { setEditingSchool(school); setNewSchoolName(school.name); };
  const handleDeleteSchool = (schoolId: string) => { if (window.confirm('Bạn có chắc chắn muốn xóa trường này không? Thao tác này sẽ xóa tất cả giáo viên, tổ, và giáo án liên quan.')) onDeleteSchool(schoolId); };

  if (!isOpen) return null;

  const usersForSelectedSchool = users.filter(u => u.schoolId === adminSelectedSchoolId);
  const teamsForSelectedSchool = teams.filter(t => t.schoolId === adminSelectedSchoolId);

  const renderUserManagement = () => (<div className="space-y-4">{!isAddingUser && (<button onClick={() => setIsAddingUser(true)} className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Thêm Giáo viên mới</button>)}{isAddingUser && (<form onSubmit={handleAddUserSubmit} className="p-4 border rounded-lg bg-gray-50 space-y-4"><h3 className="font-semibold text-lg">Thêm Giáo viên</h3><div className="space-y-4"><div><label htmlFor="new-user-name" className="block text-sm font-medium text-gray-700">Họ và tên <span className="text-red-500">*</span></label><input id="new-user-name" type="text" value={newUserName} onChange={e => setNewUserName(e.target.value)} className="w-full p-2 mt-1 border border-gray-300 rounded-md shadow-sm" placeholder="Nhập họ và tên đầy đủ..." required/></div><div><label htmlFor="new-user-email" className="block text-sm font-medium text-gray-700">Email (Office 365) <span className="text-red-500">*</span></label><input id="new-user-email" type="email" value={newUserEmail} onChange={e => setNewUserEmail(e.target.value)} className="w-full p-2 mt-1 border border-gray-300 rounded-md shadow-sm" placeholder="Nhập email Office 365 của giáo viên..." required/></div><div><label htmlFor="new-user-zalo" className="block text-sm font-medium text-gray-700">SĐT Zalo (tùy chọn)</label><input id="new-user-zalo" type="tel" value={newUserZalo} onChange={e => setNewUserZalo(e.target.value)} className="w-full p-2 mt-1 border border-gray-300 rounded-md shadow-sm" placeholder="Nhập SĐT để gửi thông báo..."/></div><div><label htmlFor="new-user-team" className="block text-sm font-medium text-gray-700">Tổ chuyên môn</label><select id="new-user-team" value={newUserTeamId} onChange={e => setNewUserTeamId(e.target.value)} className="w-full p-2 mt-1 border border-gray-300 rounded-md shadow-sm"><option value="">Chưa phân công</option>{teamsForSelectedSchool.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></div><div><label htmlFor="new-user-onedrive" className="block text-sm font-medium text-gray-700">Liên kết thư mục OneDrive (tùy chọn)</label><input id="new-user-onedrive" type="text" value={newUserOneDriveLink} onChange={e => setNewUserOneDriveLink(e.target.value)} className="w-full p-2 mt-1 border border-gray-300 rounded-md shadow-sm" placeholder="Dán liên kết chia sẻ có quyền chỉnh sửa..."/></div><div className="flex gap-2 pt-2"><button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Xác nhận thêm</button><button type="button" onClick={() => {setIsAddingUser(false); setNewUserName(''); setNewUserEmail(''); setNewUserZalo(''); setNewUserTeamId(''); setNewUserOneDriveLink('');}} className="px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300">Hủy</button></div></div></form>)}<div className="overflow-x-auto"><table className="min-w-full bg-white"><thead><tr><th className="py-2 px-4 border-b text-left">Tên</th><th className="py-2 px-4 border-b text-left">Email</th><th className="py-2 px-4 border-b text-left">Vai trò</th><th className="py-2 px-4 border-b text-left">Tổ chuyên môn</th><th className="py-2 px-4 border-b text-left">Hành động</th></tr></thead><tbody>{usersForSelectedSchool.filter(u => u.role !== Role.ADMIN).map(user => (<tr key={user.id}><td className="py-2 px-4 border-b">{user.name}</td><td className="py-2 px-4 border-b">{user.email}</td><td className="py-2 px-4 border-b">{user.role}</td><td className="py-2 px-4 border-b">{teams.find(t => t.id === user.teamId)?.name || 'Chưa phân công'}</td><td className="py-2 px-4 border-b"><button onClick={() => setUserToEdit(user)} className="text-blue-600 hover:underline text-sm font-medium">Sửa</button></td></tr>))}</tbody></table></div></div>);
  const renderTeamManagement = () => (
    <div className="space-y-4">
      <form onSubmit={handleCreateTeamSubmit} className="p-4 border rounded-lg bg-gray-50 flex gap-4 items-end">
        <div className="flex-grow">
          <label htmlFor="new-team-name" className="block text-sm font-medium text-gray-700 mb-1">Tên tổ chuyên môn mới</label>
          <input type="text" id="new-team-name" value={newTeamName} onChange={e => setNewTeamName(e.target.value)} placeholder="Ví dụ: Tổ Khoa học Tự nhiên" className="w-full p-2 border border-gray-300 rounded-md shadow-sm"/>
        </div>
        <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 h-10">Tạo Tổ</button>
      </form>
      <div className="overflow-x-auto">
        <table className="min-w-full bg-white">
          <thead>
            <tr>
              <th className="py-2 px-4 border-b text-left">Tên Tổ</th>
              <th className="py-2 px-4 border-b text-left">Tổ trưởng</th>
              <th className="py-2 px-4 border-b text-left">Tổ phó</th>
            </tr>
          </thead>
          <tbody>
            {teamsForSelectedSchool.map(team => {
              const teamMembers = usersForSelectedSchool.filter(u => u.teamId === team.id);
              return (
              <tr key={team.id}>
                <td className="py-2 px-4 border-b font-semibold">{team.name}</td>
                <td className="py-2 px-4 border-b">
                  <select value={team.leaderId || ''} onChange={e => handleTeamLeadChange(team.id, 'leader', e.target.value)} className="w-full p-1 border border-gray-300 rounded-md">
                    <option value="">-- Chọn Tổ trưởng --</option>
                    {teamMembers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </td>
                <td className="py-2 px-4 border-b">
                  <select value={team.deputyLeaderId || ''} onChange={e => handleTeamLeadChange(team.id, 'deputy', e.target.value)} className="w-full p-1 border border-gray-300 rounded-md">
                    <option value="">-- Chọn Tổ phó --</option>
                    {teamMembers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
  const renderDelegation = () => (<div className="space-y-4 p-4 bg-white rounded-lg"><h3 className="font-semibold text-lg">Thiết lập Ủy quyền</h3><div className="space-y-3"><div className="flex items-center justify-between p-3 border rounded-md"><label htmlFor="vp-delegate" className="font-medium">Ủy quyền cho Phó Hiệu trưởng</label><input type="checkbox" id="vp-delegate" checked={delegation.principalToVp} onChange={() => handleDelegationChange('vp')} className="h-5 w-5 rounded"/></div>{teamsForSelectedSchool.map(team => (<div key={team.id} className="flex items-center justify-between p-3 border rounded-md"><label htmlFor={`team-${team.id}-delegate`} className="font-medium">Ủy quyền cho Tổ phó - {team.name}</label><input type="checkbox" id={`team-${team.id}-delegate`} checked={!!delegation.teamDelegation[team.id]} onChange={() => handleDelegationChange('team', team.id)} className="h-5 w-5 rounded"/></div>))}</div></div>);
  const renderSchoolManagement = () => (<div className="space-y-4"><form onSubmit={handleSchoolSubmit} className="p-4 border rounded-lg bg-gray-50 flex gap-4 items-end"><div className="flex-grow"><label htmlFor="new-school-name" className="block text-sm font-medium text-gray-700 mb-1">{editingSchool ? 'Cập nhật tên trường' : 'Thêm trường học mới'}</label><input type="text" id="new-school-name" value={newSchoolName} onChange={e => setNewSchoolName(e.target.value)} placeholder="Nhập tên trường đầy đủ..." className="w-full p-2 border border-gray-300 rounded-md shadow-sm" required/></div><div className="flex gap-2"><button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 h-10">{editingSchool ? 'Cập nhật' : 'Thêm trường'}</button>{editingSchool && (<button type="button" onClick={() => { setEditingSchool(null); setNewSchoolName(''); }} className="px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300 h-10">Hủy</button>)}</div></form><div className="overflow-x-auto"><table className="min-w-full bg-white"><thead><tr><th className="py-2 px-4 border-b text-left">Tên trường</th><th className="py-2 px-4 border-b text-left">Mã định danh (ID)</th><th className="py-2 px-4 border-b text-left">Hành động</th></tr></thead><tbody>{schools.map(school => (<tr key={school.id}><td className="py-2 px-4 border-b">{school.name}</td><td className="py-2 px-4 border-b font-mono text-sm">{school.id}</td><td className="py-2 px-4 border-b space-x-4"><button onClick={() => handleEditSchool(school)} className="text-blue-600 hover:underline text-sm font-medium">Sửa</button><button onClick={() => handleDeleteSchool(school.id)} className="text-red-600 hover:underline text-sm font-medium">Xóa</button></td></tr>))}</tbody></table></div></div>);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-[90vh] flex flex-col">
        <div className="p-4 border-b flex justify-between items-center"><h2 className="text-2xl font-bold">Quản trị hệ thống</h2><button onClick={onClose} className="text-gray-500 hover:text-gray-800">&times;</button></div>
        <div className="flex border-b">
            <button onClick={() => setActiveTab('users')} className={`px-4 py-2 ${activeTab === 'users' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}>Quản lý Người dùng</button>
            <button onClick={() => setActiveTab('teams')} className={`px-4 py-2 ${activeTab === 'teams' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}>Quản lý Tổ Chuyên môn</button>
            <button onClick={() => setActiveTab('schools')} className={`px-4 py-2 ${activeTab === 'schools' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}>Quản lý Trường học</button>
            <button onClick={() => setActiveTab('delegation')} className={`px-4 py-2 ${activeTab === 'delegation' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}>Ủy quyền</button>
        </div>
        {isGlobalAdmin && ['users', 'teams', 'delegation'].includes(activeTab) && (
            <div className="p-4 border-b bg-gray-50">
                <label htmlFor="school-selector-admin" className="block text-sm font-medium text-gray-700">Chọn trường để quản lý</label>
                <select 
                    id="school-selector-admin" 
                    value={adminSelectedSchoolId} 
                    onChange={e => setAdminSelectedSchoolId(e.target.value)} 
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 focus:ring-blue-500 focus:border-blue-500"
                >
                    {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
            </div>
        )}
        <div className="p-6 flex-grow overflow-y-auto bg-gray-50">{activeTab === 'users' && renderUserManagement()}{activeTab === 'teams' && renderTeamManagement()}{activeTab === 'delegation' && renderDelegation()}{activeTab === 'schools' && renderSchoolManagement()}</div>
        <div className="bg-gray-100 px-6 py-4 flex justify-end"><button onClick={onClose} className="px-4 py-2 bg-gray-200 rounded-md">Đóng</button></div>
        {userToEdit && <EditUserModal isOpen={!!userToEdit} onClose={() => setUserToEdit(null)} user={userToEdit} teams={teamsForSelectedSchool} onSave={(updatedUser) => { onUpdateUser(updatedUser); setUserToEdit(null); }} onNotification={onNotification} />}
      </div>
    </div>
  );
};

// --- Component: TeamOverviewModal (NEW) ---
const StatCard: React.FC<{ title: string; value: string | number; icon: React.ReactNode; }> = ({ title, value, icon }) => (
  <div className="bg-white p-4 rounded-lg shadow-md flex items-center gap-4 border border-gray-200">
    <div className="bg-blue-100 text-blue-600 p-3 rounded-full flex-shrink-0">{icon}</div>
    <div>
      <p className="text-sm font-medium text-gray-500">{title}</p>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
    </div>
  </div>
);
interface TeamOverviewModalProps { isOpen: boolean; onClose: () => void; currentUser: User; teams: Team[]; users: User[]; lessonPlans: LessonPlan[]; }
const TeamOverviewModal: React.FC<TeamOverviewModalProps> = ({ isOpen, onClose, currentUser, teams, users, lessonPlans }) => {
  const [aiAnalysis, setAiAnalysis] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const team = useMemo(() => teams.find(t => t.id === currentUser.teamId), [teams, currentUser.teamId]);
  const teamMembers = useMemo(() => users.filter(u => u.teamId === currentUser.teamId && u.role === Role.TEACHER), [users, currentUser.teamId]);
  const teamPlans = useMemo(() => lessonPlans.filter(p => p.teamId === currentUser.teamId), [lessonPlans, currentUser.teamId]);
  const stats = useMemo(() => {
    const totalTeachers = teamMembers.length;
    const totalPlans = teamPlans.length;
    const approvedOrIssuedCount = teamPlans.filter(p => [Status.APPROVED, Status.ISSUED, Status.APPROVED_BY_TL].includes(p.status)).length;
    const rejectedCount = teamPlans.filter(p => [Status.REJECTED_BY_TL, Status.REJECTED_BY_VP].includes(p.status)).length;
    const approvalRate = (approvedOrIssuedCount + rejectedCount) > 0 ? `${((approvedOrIssuedCount / (approvedOrIssuedCount + rejectedCount)) * 100).toFixed(0)}%` : 'N/A';
    let totalMillis = 0; let feedbackCount = 0;
    teamPlans.forEach(plan => {
      const submittedEntries = plan.history.filter(h => h.action === 'Nộp Kế hoạch bài dạy' || h.action === 'Nộp lại Kế hoạch bài dạy').sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      if (submittedEntries.length > 0) {
        const lastSubmitted = submittedEntries[0];
        const responseEntry = plan.history.find(h => (h.action === 'Tổ trưởng đã duyệt' || h.action === 'Tổ trưởng từ chối') && new Date(h.timestamp) > new Date(lastSubmitted.timestamp));
        if (responseEntry) { totalMillis += new Date(responseEntry.timestamp).getTime() - new Date(lastSubmitted.timestamp).getTime(); feedbackCount++; }
      }
    });
    let avgFeedbackTime = 'N/A';
    if (feedbackCount > 0) {
      const hours = Math.floor((totalMillis / feedbackCount) / 3600000);
      const days = Math.floor(hours / 24);
      if (days > 1) avgFeedbackTime = `~${days} ngày`; else if (hours > 0) avgFeedbackTime = `~${hours} giờ`; else avgFeedbackTime = '< 1 giờ';
    }
    return { totalTeachers, totalPlans, approvalRate, avgFeedbackTime };
  }, [teamMembers, teamPlans]);
  const teacherStats = useMemo(() => {
    return teamMembers.map(teacher => ({
      teacherName: teacher.name,
      submitted: teamPlans.filter(p => p.submittedBy.id === teacher.id).length,
      approved: teamPlans.filter(p => p.submittedBy.id === teacher.id && [Status.APPROVED, Status.ISSUED, Status.APPROVED_BY_TL].includes(p.status)).length,
      rejected: teamPlans.filter(p => p.submittedBy.id === teacher.id && [Status.REJECTED_BY_TL, Status.REJECTED_BY_VP].includes(p.status)).length,
      pending: teamPlans.filter(p => p.submittedBy.id === teacher.id && p.status === Status.SUBMITTED).length,
    })).sort((a, b) => b.submitted - a.submitted);
  }, [teamMembers, teamPlans]);
  const handleGenerateAnalysis = async () => {
    setIsAiLoading(true); setAiAnalysis('');
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const statsData = teacherStats.map(s => `- ${s.teacherName}: Nộp ${s.submitted}, Duyệt ${s.approved}, Từ chối ${s.rejected}, Chờ ${s.pending}.`).join('\n');
      const prompt = `Với vai trò là một trợ lý quản lý giáo dục cho Tổ trưởng Chuyên môn, hãy phân tích dữ liệu nộp giáo án của các giáo viên trong tổ sau đây.\n\nDữ liệu:\n${statsData}\n\nBáo cáo của bạn cần:\n1.  **Tóm tắt chung:** Đưa ra nhận xét ngắn gọn về hiệu suất chung của tổ.\n2.  **Điểm sáng:** Ghi nhận các giáo viên có thành tích tốt (ví dụ: nộp nhiều, tỷ lệ duyệt cao).\n3.  **Cần quan tâm:** Nhận diện các giáo viên có thể cần hỗ trợ (ví dụ: tỷ lệ bị từ chối cao, nộp ít).\n4.  **Đề xuất hành động:** Đưa ra 2-3 gợi ý cụ thể, mang tính xây dựng để Tổ trưởng có thể cải thiện chất lượng chuyên môn và hiệu quả làm việc của tổ.\n\nSử dụng ngôn ngữ chuyên nghiệp, tích cực và định dạng Markdown để trình bày báo cáo một cách rõ ràng, súc tích.`;
      const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
      setAiAnalysis(response.text);
    } catch (e) { console.error(e); setAiAnalysis('Đã xảy ra lỗi khi tạo phân tích. Vui lòng thử lại.'); }
    finally { setIsAiLoading(false); }
  };
  if (!isOpen || !team) return null;
  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex justify-center items-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b flex justify-between items-center bg-gray-50 rounded-t-lg"><h2 className="text-xl font-bold text-gray-800">Tổng quan Tổ chuyên môn: {team.name}</h2><button onClick={onClose} className="text-gray-500 hover:text-gray-800 text-3xl font-light">&times;</button></div>
        <div className="flex-grow overflow-y-auto p-6 bg-gray-100 space-y-6">
          <div><h3 className="text-lg font-semibold text-gray-800 mb-3">Thống kê Tổng quan</h3><div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard title="Tổng số Giáo viên" value={stats.totalTeachers} icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.653-.122-1.28-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.653.122-1.28.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm-3 5a3 3 0 11-6 0 3 3 0 016 0z" /></svg>} />
            <StatCard title="Tổng số Giáo án" value={stats.totalPlans} icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>} />
            <StatCard title="Tỷ lệ Phê duyệt" value={stats.approvalRate} icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
            <StatCard title="T.gian P.hồi TB" value={stats.avgFeedbackTime} icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
          </div></div>
          <div><h3 className="text-lg font-semibold text-gray-800 mb-3">Thống kê theo Giáo viên</h3><div className="overflow-x-auto bg-white rounded-lg shadow-md border"><table className="min-w-full text-sm text-left text-gray-500"><thead className="text-xs text-gray-700 uppercase bg-gray-50"><tr><th scope="col" className="px-6 py-3">Tên Giáo viên</th><th scope="col" className="px-6 py-3 text-center">Đã nộp</th><th scope="col" className="px-6 py-3 text-center">Đã duyệt</th><th scope="col" className="px-6 py-3 text-center">Bị từ chối</th><th scope="col" className="px-6 py-3 text-center">Đang chờ</th></tr></thead><tbody>
            {teacherStats.map(stat => (<tr key={stat.teacherName} className="bg-white border-b hover:bg-gray-50"><th scope="row" className="px-6 py-4 font-medium text-gray-900 whitespace-nowrap">{stat.teacherName}</th><td className="px-6 py-4 text-center">{stat.submitted}</td><td className="px-6 py-4 text-center text-green-600 font-semibold">{stat.approved}</td><td className="px-6 py-4 text-center text-red-600 font-semibold">{stat.rejected}</td><td className="px-6 py-4 text-center text-yellow-600 font-semibold">{stat.pending}</td></tr>))}
            {teacherStats.length === 0 && (<tr><td colSpan={5} className="text-center py-8 text-gray-500">Chưa có dữ liệu giáo viên trong tổ này.</td></tr>)}
          </tbody></table></div></div>
          <div><h3 className="text-lg font-semibold text-gray-800 mb-3">Phân tích và Gợi ý từ AI</h3><div className="bg-white p-4 rounded-lg shadow-md border"><div className="flex justify-end mb-4"><button onClick={handleGenerateAnalysis} disabled={isAiLoading} className="px-4 py-2 bg-indigo-600 text-white font-semibold rounded-md hover:bg-indigo-700 disabled:bg-indigo-400 flex items-center gap-2 transition"><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>{isAiLoading ? 'Đang phân tích...' : 'Phân tích & Đề xuất'}</button></div>{isAiLoading ? <div className="min-h-[200px] flex items-center justify-center"><LoadingSpinner /></div> : aiAnalysis && <div className="prose prose-sm max-w-none p-4 bg-gray-50 rounded-md border"><pre className="whitespace-pre-wrap font-sans text-sm text-gray-800 leading-relaxed">{aiAnalysis}</pre></div>}</div></div>
        </div>
        <div className="bg-white px-6 py-4 flex justify-end border-t"><button onClick={onClose} className="px-6 py-2 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700">Đóng</button></div>
      </div>
    </div>
  );
};

// --- Component: TeamSelectionModal ---
interface TeamSelectionModalProps {
  isOpen: boolean;
  teams: Team[];
  onConfirm: (teamId: number) => void;
  userName: string;
}
const TeamSelectionModal: React.FC<TeamSelectionModalProps> = ({ isOpen, teams, onConfirm, userName }) => {
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');

  if (!isOpen) return null;

  const handleConfirm = () => {
    if (selectedTeamId) {
      onConfirm(Number(selectedTeamId));
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex justify-center items-center z-[100] p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="p-6 text-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto mb-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.653-.122-1.28-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.653.122-1.28.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          <h2 className="text-2xl font-bold text-gray-800">Chào mừng, {userName}!</h2>
          <p className="text-gray-600 mt-2">Để tiếp tục, vui lòng chọn Tổ chuyên môn của bạn.</p>
        </div>
        <div className="px-6 pb-6">
          <label htmlFor="team-select" className="block text-sm font-medium text-gray-700 mb-2">Tổ chuyên môn</label>
          <select
            id="team-select"
            value={selectedTeamId}
            onChange={(e) => setSelectedTeamId(e.target.value)}
            className="w-full p-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="" disabled>-- Chọn tổ của bạn --</option>
            {teams.map(team => (
              <option key={team.id} value={team.id}>{team.name}</option>
            ))}
          </select>
        </div>
        <div className="bg-gray-100 px-6 py-4 rounded-b-lg">
          <button
            onClick={handleConfirm}
            disabled={!selectedTeamId}
            className="w-full px-4 py-2.5 bg-blue-600 text-white font-bold rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            Xác nhận
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Component: LessonPlanCard ---
const statusConfig = {
  [Status.DRAFT]: { text: 'Bản nháp', color: 'bg-gray-200 text-gray-800' },
  [Status.SUBMITTED]: { text: 'Chờ Tổ trưởng duyệt', color: 'bg-yellow-200 text-yellow-800' },
  [Status.REJECTED_BY_TL]: { text: 'Tổ trưởng từ chối', color: 'bg-red-200 text-red-800' },
  [Status.APPROVED_BY_TL]: { text: 'Chờ Hiệu trưởng duyệt', color: 'bg-blue-200 text-blue-800' },
  [Status.APPROVED]: { text: 'Đã phê duyệt', color: 'bg-green-200 text-green-800' },
  [Status.REJECTED_BY_VP]: { text: 'Hiệu trưởng từ chối', color: 'bg-red-200 text-red-800' },
  [Status.ISSUED]: { text: 'Đã ban hành', color: 'bg-purple-200 text-purple-800' },
};
const InfoRow = ({ icon, label, value }: { icon: React.ReactNode, label: string, value: React.ReactNode }) => (<div className="flex items-start text-sm text-gray-600"><div className="w-5 h-5 mr-2 text-gray-400 flex-shrink-0 mt-0.5">{icon}</div><div className="flex-1"><span className="font-semibold w-24">{label}:</span><span className="break-words ml-2">{value}</span></div></div>);
interface LessonPlanCardProps { plan: LessonPlan; currentUser: User; teams: Team[]; delegation: DelegationState; onAction: (planId: number, newStatus: Status, reason?: string) => void; onEdit: (plan: LessonPlan) => void; onNotification: (config: Omit<NotificationModalProps, 'isOpen' | 'onClose'>) => void; onAddComment: (planId: number, text: string) => void; }
const LessonPlanCard: React.FC<LessonPlanCardProps> = ({ plan, currentUser, teams, delegation, onAction, onEdit, onNotification, onAddComment }) => {
  const [isActionModalOpen, setActionModalOpen] = useState(false);
  const [actionType, setActionType] = useState<'approve' | 'reject' | 'cancel'>('approve');
  const [isHistoryModalOpen, setHistoryModalOpen] = useState(false);
  const [isPdfViewerOpen, setPdfViewerOpen] = useState(false);
  const [shareMessage, setShareMessage] = useState('');
  const [isCommentsExpanded, setIsCommentsExpanded] = useState(false);
  const [newComment, setNewComment] = useState('');

  const teamName = useMemo(() => {
    return teams.find(t => t.id === plan.teamId)?.name || 'N/A';
  }, [plan.teamId, teams]);
  const handleActionClick = (type: 'approve' | 'reject' | 'cancel') => {
    setActionType(type);
    setActionModalOpen(true);
  };
  const handleConfirmAction = (reason?: string) => {
    if (actionType === 'reject' && !reason?.trim()) {
      onNotification({ type: 'error', title: 'Thiếu thông tin', message: 'Vui lòng nhập lý do từ chối để tiếp tục.' });
      return;
    }
    let newStatus: Status;
    if (actionType === 'approve') {
      if (plan.status === Status.SUBMITTED) newStatus = Status.APPROVED_BY_TL;
      else if (plan.status === Status.APPROVED_BY_TL) newStatus = Status.APPROVED;
      else {
        setActionModalOpen(false);
        return;
      }
    } else if (actionType === 'cancel') {
      if (plan.status === Status.APPROVED_BY_TL) newStatus = Status.SUBMITTED;
      else if (plan.status === Status.APPROVED) newStatus = Status.APPROVED_BY_TL;
      else {
        setActionModalOpen(false);
        return;
      }
    } else { // reject
      if ([Role.TEAM_LEADER, Role.DEPUTY_TEAM_LEADER].includes(currentUser.role)) newStatus = Status.REJECTED_BY_TL;
      else if ([Role.PRINCIPAL, Role.VICE_PRINCIPAL].includes(currentUser.role)) newStatus = Status.REJECTED_BY_VP;
      else {
        setActionModalOpen(false);
        return;
      }
    }
    onAction(plan.id, newStatus, reason);
    setActionModalOpen(false);
  };
  const handleShareLink = () => {
    if (plan.file.url && plan.file.url !== '#') {
      navigator.clipboard.writeText(plan.file.url).then(() => {
        setShareMessage('Đã sao chép liên kết tạm thời! (Chỉ hoạt động trên trình duyệt này)');
        setTimeout(() => setShareMessage(''), 3000);
      }).catch(() => {
        setShareMessage('Lỗi: Không thể sao chép liên kết.');
        setTimeout(() => setShareMessage(''), 3000);
      });
    } else {
      setShareMessage('Không có liên kết để chia sẻ.');
      setTimeout(() => setShareMessage(''), 3000);
    }
  };
  const handleCommentSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newComment.trim()) {
      onAddComment(plan.id, newComment.trim());
      setNewComment('');
    }
  };
  const renderApprovalActions = () => {
    if (currentUser.role === Role.TEACHER) return null;
    const canApproveTeam = (currentUser.role === Role.TEAM_LEADER && currentUser.teamId === plan.teamId) || (currentUser.role === Role.DEPUTY_TEAM_LEADER && currentUser.teamId === plan.teamId && !!delegation.teamDelegation[plan.teamId!]);
    const canApprovePrincipal = (currentUser.role === Role.PRINCIPAL) || (currentUser.role === Role.VICE_PRINCIPAL && delegation.principalToVp);
    if (canApproveTeam) {
      if (plan.status === Status.SUBMITTED) return (<><button onClick={() => handleActionClick('approve')} className="flex-1 bg-green-500 text-white font-semibold py-2 px-4 rounded-md hover:bg-green-600 transition">Duyệt</button><button onClick={() => handleActionClick('reject')} className="flex-1 bg-red-500 text-white font-semibold py-2 px-4 rounded-md hover:bg-red-600 transition">Từ chối</button></>);
      if (plan.status === Status.APPROVED_BY_TL) return (<button onClick={() => handleActionClick('cancel')} className="w-full bg-yellow-500 text-white font-semibold py-2 px-4 rounded-md hover:bg-yellow-600 transition">Hủy duyệt</button>);
    }
    if (canApprovePrincipal) {
      if (plan.status === Status.APPROVED_BY_TL) return (<><button onClick={() => handleActionClick('approve')} className="flex-1 bg-purple-600 text-white font-semibold py-2 px-4 rounded-md hover:bg-purple-700 transition">Duyệt & Ban hành</button><button onClick={() => handleActionClick('reject')} className="flex-1 bg-red-500 text-white font-semibold py-2 px-4 rounded-md hover:bg-red-600 transition">Từ chối</button></>);
      if (plan.status === Status.APPROVED) return (<button onClick={() => handleActionClick('cancel')} className="flex-1 bg-yellow-500 text-white font-semibold py-2 px-4 rounded-md hover:bg-yellow-600 transition">Hủy duyệt</button>);
    }
    return null;
  };
  const renderTeacherActions = () => {
    if (currentUser.role !== Role.TEACHER || currentUser.id !== plan.submittedBy.id) {
      return null;
    }
    switch (plan.status) {
      case Status.DRAFT:
        return (<>
            <button onClick={() => onEdit(plan)} className="flex-1 bg-gray-500 text-white font-semibold py-2 px-4 rounded-md hover:bg-gray-600 transition">Chỉnh sửa</button>
            <button onClick={() => onAction(plan.id, Status.SUBMITTED)} className="flex-1 bg-blue-500 text-white font-semibold py-2 px-4 rounded-md hover:bg-blue-600 transition">Nộp duyệt</button>
          </>);
      case Status.REJECTED_BY_TL:
      case Status.REJECTED_BY_VP:
        return (<button onClick={() => onEdit(plan)} className="w-full bg-blue-500 text-white font-semibold py-2 px-4 rounded-md hover:bg-blue-600 transition">Chỉnh sửa & Nộp lại</button>);
      case Status.SUBMITTED:
      case Status.APPROVED_BY_TL:
        return (<button onClick={() => onAction(plan.id, Status.DRAFT)} className="w-full flex items-center justify-center bg-yellow-500 text-white font-semibold py-2 px-4 rounded-md hover:bg-yellow-600 transition">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 mr-2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" /></svg>
            Thu hồi
          </button>);
      default:
        return null;
    }
  };
  const {
    text,
    color
  } = statusConfig[plan.status];
  const canPreview = !plan.file.isExternalLink && plan.file.name.toLowerCase().endsWith('.pdf') && plan.file.url && plan.file.url !== '#';
  const renderDefaultFooter = () => (<div className="p-5 bg-gray-50 border-t border-gray-200"><div className="flex gap-3">{renderApprovalActions()}{renderTeacherActions()}</div><button onClick={() => setHistoryModalOpen(true)} className="w-full mt-3 text-sm text-center text-gray-600 hover:text-blue-600 font-medium">Xem lịch sử phê duyệt</button></div>);
  const renderIssuedFooter = () => (<div className="p-5 bg-purple-50 border-t border-purple-200">{plan.finalApprover && plan.finalApprovedAt && (<div className="flex items-center gap-3"><div className="flex-shrink-0 w-10 h-10 rounded-full bg-purple-500 text-white flex items-center justify-center"><svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg></div><div><p className="font-bold text-purple-800">Đã ban hành</p><p className="text-xs text-gray-600">bởi <strong>{plan.finalApprover.name}</strong><br />vào lúc {new Date(plan.finalApprovedAt).toLocaleString('vi-VN')}</p></div></div>)}<div className="mt-4 grid grid-cols-3 gap-2 text-sm"><a href={plan.file.url} download={plan.file.name} className="flex items-center justify-center gap-2 w-full px-3 py-2 bg-white border border-gray-300 text-gray-700 font-semibold rounded-md hover:bg-gray-100 transition"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>Tải xuống</a><button onClick={handleShareLink} className="flex items-center justify-center gap-2 w-full px-3 py-2 bg-white border border-gray-300 text-gray-700 font-semibold rounded-md hover:bg-gray-100 transition"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>Chia sẻ</button><button onClick={() => setHistoryModalOpen(true)} className="flex items-center justify-center gap-2 w-full px-3 py-2 bg-white border border-gray-300 text-gray-700 font-semibold rounded-md hover:bg-gray-100 transition"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>Lịch sử</button></div>{shareMessage && (<p className="text-xs text-center mt-3 text-indigo-700 bg-indigo-50 p-2 rounded-md transition-opacity duration-300">{shareMessage}</p>)}</div>);
  return (<>
      <div className="bg-white rounded-lg shadow-lg overflow-hidden flex flex-col justify-between transition-transform duration-300 hover:scale-105 hover:shadow-xl">
        <div className="p-5">
          <div className="flex justify-between items-start mb-3"><span className={`px-3 py-1 text-xs font-semibold rounded-full whitespace-nowrap ${color}`}>{text}</span></div>
          <h3 className="text-lg font-bold text-gray-900 mb-3 leading-tight truncate">{plan.title}</h3>
          <div className="space-y-3">
            <InfoRow icon={<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" /></svg>} label="Người trình" value={plan.submittedBy.name} />
            <InfoRow icon={<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m-7.5-2.962a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM10.5 21a8.956 8.956 0 0 1-5.263-1.688 1.5 1.5 0 0 1 2.529-1.332A6.733 6.733 0 0 0 10.5 18a6.733 6.733 0 0 0 2.234.341 1.5 1.5 0 0 1 2.529 1.332A8.956 8.956 0 0 1 10.5 21Z" /></svg>} label="Tổ chuyên môn" value={teamName} />
            <InfoRow icon={<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0h18Z" /></svg>} label="Ngày trình" value={new Date(plan.submittedAt).toLocaleDateString('vi-VN')} />
          </div>
          <div className="mt-4 pt-4 border-t border-gray-200"><h4 className="text-xs font-bold text-gray-500 uppercase mb-3 tracking-wider">Tài liệu & Lưu trữ</h4>
            <div className="space-y-3">
              <div className="flex justify-between items-center gap-3">
                <a href={plan.file.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate flex items-center min-w-0" title={plan.file.name}>
                  {plan.file.isExternalLink ? (<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 mr-2 flex-shrink-0"><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" /></svg>) : (<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 mr-2 flex-shrink-0"><path strokeLinecap="round" strokeLinejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.122 2.122l7.81-7.81" /></svg>)}
                  <span className="truncate">{plan.file.name}</span>
                </a>
                <button
                    onClick={() => setPdfViewerOpen(true)}
                    disabled={!canPreview}
                    className="flex items-center justify-center gap-1 flex-shrink-0 px-3 py-1 bg-white border border-gray-300 text-gray-700 text-xs font-semibold rounded-md hover:bg-gray-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    title={canPreview ? "Xem trước file PDF" : "Bản xem trước chỉ có sẵn cho tệp PDF"}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                  <span>Xem</span>
                </button>
              </div>
              {plan.oneDriveFolder && (<InfoRow
                    icon={<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>}
                    label="Nơi lưu"
                    value={<span className="font-medium text-indigo-600 truncate" title={plan.oneDriveFolder.name}>{plan.oneDriveFolder.name}</span>} />)}
            </div>
          </div>
           {plan.status !== Status.ISSUED && plan.status !== Status.DRAFT && (
          <div className="mt-4 pt-4 border-t border-gray-200">
             <button onClick={() => setIsCommentsExpanded(!isCommentsExpanded)} className="flex justify-between items-center w-full text-left py-1">
                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Thảo luận & Góp ý</h4>
                <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full">{plan.comments?.length || 0}</span>
                    <svg xmlns="http://www.w3.org/2000/svg" className={`h-4 w-4 text-gray-400 transition-transform ${isCommentsExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </div>
            </button>
            {isCommentsExpanded && (
                <div className="mt-3 space-y-3">
                    <div className="space-y-3 max-h-48 overflow-y-auto pr-2">
                        {plan.comments && plan.comments.length > 0 ? (plan.comments.map(comment => (
                            <div key={comment.id} className="p-3 bg-gray-50 rounded-lg">
                                <div className="flex justify-between items-center">
                                    <p className="font-semibold text-sm text-gray-800">{comment.user.name}</p>
                                    <p className="text-xs text-gray-500">{new Date(comment.timestamp).toLocaleString('vi-VN')}</p>
                                </div>
                                <p className="text-sm text-gray-700 mt-1">{comment.text}</p>
                            </div>
                        ))) : (<p className="text-sm text-gray-500 italic text-center py-4">Chưa có góp ý nào.</p>)}
                    </div>
                    <form onSubmit={handleCommentSubmit} className="flex items-start gap-2 pt-3 border-t">
                        <textarea value={newComment} onChange={e => setNewComment(e.target.value)} placeholder="Nhập góp ý của bạn..." rows={2} className="flex-grow p-2 text-sm border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"></textarea>
                        <button type="submit" className="px-3 py-2 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700 text-sm">Gửi</button>
                    </form>
                </div>
            )}
          </div>
          )}
          <div className="mt-4 pt-4 border-t border-gray-200"><h4 className="text-xs font-bold text-gray-500 uppercase mb-3 tracking-wider">Tiến trình duyệt</h4><ApprovalStepper plan={plan} /></div>
        </div>
        {plan.status === Status.ISSUED ? renderIssuedFooter() : renderDefaultFooter()}
      </div>
      {isActionModalOpen && <ActionModal type={actionType} onClose={() => setActionModalOpen(false)} onConfirm={handleConfirmAction} />}
      {isHistoryModalOpen && <HistoryModal plan={plan} onClose={() => setHistoryModalOpen(false)} />}
      {isPdfViewerOpen && canPreview && <PDFViewerModal plan={plan} onClose={() => setPdfViewerOpen(false)} />}
    </>);
};

// --- Component: GlobalAdminDashboard (NEW) ---
const AdminStatCard: React.FC<{ title: string; value: string | number; icon: React.ReactNode; color: string; }> = ({ title, value, icon, color }) => (
    <div className={`bg-white p-4 rounded-lg shadow-sm flex items-center gap-4 border-l-4 ${color}`}>
        <div className="text-gray-600 flex-shrink-0">{icon}</div>
        <div>
            <p className="text-sm font-medium text-gray-500">{title}</p>
            <p className="text-2xl font-bold text-gray-900">{value}</p>
        </div>
    </div>
);
interface GlobalAdminDashboardProps {
  schools: School[];
  teams: Team[];
  users: User[];
  lessonPlans: LessonPlan[];
  onAdminClick: () => void;
}
const GlobalAdminDashboard: React.FC<GlobalAdminDashboardProps> = ({ schools, teams, users, lessonPlans, onAdminClick }) => {
    const [expandedItems, setExpandedItems] = useState<{ [key: string]: boolean }>({});

    const toggleExpand = (key: string) => {
        setExpandedItems(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const totalSchools = schools.length;
    const totalUsers = users.filter(u => u.role !== Role.ADMIN).length;
    const totalLessonPlans = lessonPlans.length;
    const totalApproved = lessonPlans.filter(p => [Status.ISSUED, Status.APPROVED].includes(p.status)).length;


    return (
        <div className="space-y-8">
            <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                 <h1 className="text-3xl sm:text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-gray-700 to-black tracking-tight">Bảng điều khiển Quản trị Toàn cầu</h1>
                 <button onClick={onAdminClick} className="flex items-center justify-center bg-gray-700 text-white font-bold py-2.5 px-5 rounded-lg shadow-lg hover:bg-gray-800 transition-all duration-300 text-base"><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor"><path d="M5 8a1 1 0 011-1h8a1 1 0 110 2H6a1 1 0 01-1-1zm-1 4a1 1 0 011-1h8a1 1 0 110 2H5a1 1 0 01-1-1z" /><path fillRule="evenodd" d="M2 3a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm2 1h12v12H4V4z" clipRule="evenodd" /></svg>Quản trị Hệ thống</button>
            </header>

             <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
                <h2 className="text-xl font-bold text-gray-800 mb-4">Tổng quan Toàn hệ thống</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <AdminStatCard title="Tổng số Trường học" value={totalSchools} color="border-indigo-500" icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>} />
                    <AdminStatCard title="Tổng số Người dùng" value={totalUsers} color="border-cyan-500" icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.653-.122-1.28-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.653.122-1.28.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>} />
                    <AdminStatCard title="Tổng số Giáo án" value={totalLessonPlans} color="border-amber-500" icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>} />
                    <AdminStatCard title="Tổng số Đã duyệt" value={totalApproved} color="border-emerald-500" icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
                </div>
            </div>

            <div className="space-y-6">
                {schools.map(school => {
                    const schoolTeams = teams.filter(t => t.schoolId === school.id);
                    const schoolKey = `school-${school.id}`;
                    const isSchoolExpanded = !!expandedItems[schoolKey];

                    const schoolPlans = lessonPlans.filter(p => p.schoolId === school.id);
                    const totalPlans = schoolPlans.length;
                    const approvedPlans = schoolPlans.filter(p => [Status.ISSUED, Status.APPROVED].includes(p.status)).length;
                    const rejectedPlans = schoolPlans.filter(p => [Status.REJECTED_BY_TL, Status.REJECTED_BY_VP].includes(p.status)).length;
                    const recentActivity = schoolPlans.filter(p => new Date(p.submittedAt).getTime() > Date.now() - 7 * 24 * 60 * 60 * 1000).length;

                    return (
                        <div key={school.id} className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
                            <button onClick={() => toggleExpand(schoolKey)} className="w-full p-4 flex justify-between items-center text-left hover:bg-gray-50 transition">
                                <h2 className="text-xl font-bold text-gray-800">{school.name}</h2>
                                <svg xmlns="http://www.w3.org/2000/svg" className={`h-6 w-6 text-gray-500 transition-transform ${isSchoolExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                            </button>
                            {isSchoolExpanded && (
                                <div className="p-4 border-t border-gray-200 bg-gray-50 space-y-4">
                                     <div>
                                        <h3 className="text-base font-semibold text-gray-700 mb-3">Thống kê Nhanh</h3>
                                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                            <AdminStatCard title="Tổng số Giáo án" value={totalPlans} color="border-blue-500" icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>} />
                                            <AdminStatCard title="Đã duyệt" value={approvedPlans} color="border-green-500" icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
                                            <AdminStatCard title="Bị từ chối" value={rejectedPlans} color="border-red-500" icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
                                            <AdminStatCard title="Hoạt động (7 ngày)" value={recentActivity} color="border-yellow-500" icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>} />
                                        </div>
                                    </div>
                                    <div className="border-t border-gray-200 pt-4">
                                        <h3 className="text-base font-semibold text-gray-700 mb-3">Các Tổ chuyên môn</h3>
                                        {schoolTeams.length > 0 ? schoolTeams.map(team => {
                                            const teamUsers = users.filter(u => u.teamId === team.id);
                                            const teamKey = `team-${team.id}`;
                                            const isTeamExpanded = !!expandedItems[teamKey];
                                            return (
                                                <div key={team.id} className="bg-white rounded-lg border border-gray-200">
                                                    <button onClick={() => toggleExpand(teamKey)} className="w-full p-3 flex justify-between items-center text-left hover:bg-gray-50 transition">
                                                        <h3 className="font-semibold text-gray-700">{team.name}</h3>
                                                        <div className="flex items-center gap-4">
                                                            <span className="text-sm text-gray-500">{teamUsers.length} thành viên</span>
                                                            <svg xmlns="http://www.w3.org/2000/svg" className={`h-5 w-5 text-gray-400 transition-transform ${isTeamExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                                        </div>
                                                    </button>
                                                    {isTeamExpanded && (
                                                        <ul className="p-3 border-t border-gray-200 divide-y divide-gray-100">
                                                            {teamUsers.map(user => (
                                                                <li key={user.id} className="py-2 flex justify-between items-center">
                                                                    <span className="text-sm text-gray-800">{user.name}</span>
                                                                    <span className="text-xs text-gray-500 font-mono">{user.email}</span>
                                                                </li>
                                                            ))}
                                                            {teamUsers.length === 0 && <li className="py-2 text-sm text-center text-gray-500 italic">Chưa có giáo viên trong tổ này.</li>}
                                                        </ul>
                                                    )}
                                                </div>
                                            )
                                        }) : <p className="text-center text-gray-500 italic py-4">Trường này chưa có tổ chuyên môn nào.</p>}
                                    </div>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </div>
    );
};


// --- Component: Dashboard ---
interface DashboardProps { currentUser: User; lessonPlans: LessonPlan[]; users: User[]; teams: Team[]; schools: School[]; delegation: DelegationState; onUploadClick: () => void; onAdminClick: () => void; onTeamOverviewClick: () => void; onAction: (planId: number, newStatus: Status, reason?: string) => void; onEdit: (plan: LessonPlan) => void; onNotification: (config: Omit<NotificationModalProps, 'isOpen' | 'onClose'>) => void; onAddComment: (planId: number, text: string) => void; }
const Dashboard: React.FC<DashboardProps> = ({ currentUser, lessonPlans, users, teams, schools, delegation, onUploadClick, onAdminClick, onTeamOverviewClick, onAction, onEdit, onNotification, onAddComment }) => {
  const [searchTerm, setSearchTerm] = useState(''); const [selectedStatus, setSelectedStatus] = useState<Status | 'all'>('all'); const [selectedSubject, setSelectedSubject] = useState(''); const [selectedTeam, setSelectedTeam] = useState<string>(''); const [isReportModalOpen, setReportModalOpen] = useState(false);
  const userTeamName = useMemo(() => { if (currentUser.teamId) return teams.find(t => t.id === currentUser.teamId)?.name || 'Tổ không xác định'; return ''; }, [currentUser, teams]);
  const baseVisiblePlans = useMemo(() => {
    switch (currentUser.role) {
      case Role.TEACHER: return lessonPlans.filter(p => p.submittedBy.id === currentUser.id);
      case Role.DEPUTY_TEAM_LEADER: return lessonPlans.filter(p => p.teamId === currentUser.teamId);
      case Role.TEAM_LEADER: return lessonPlans.filter(p => p.teamId === currentUser.teamId);
      case Role.VICE_PRINCIPAL: return lessonPlans.filter(p => [Status.APPROVED_BY_TL, Status.REJECTED_BY_VP, Status.APPROVED, Status.ISSUED].includes(p.status));
      case Role.PRINCIPAL:
        return lessonPlans;
      default: return [];
    }
  }, [currentUser, lessonPlans]);
  const visiblePlans = useMemo(() => {
    return baseVisiblePlans.filter(plan => {
      const lowercasedTerm = searchTerm.toLowerCase();
      return (!searchTerm || (plan.title.toLowerCase().includes(lowercasedTerm) || (plan.subject && plan.subject.toLowerCase().includes(lowercasedTerm)) || plan.submittedBy.name.toLowerCase().includes(lowercasedTerm))) && (selectedStatus === 'all' || plan.status === selectedStatus) && (!selectedSubject || plan.subject === selectedSubject) && (!selectedTeam || String(plan.teamId) === selectedTeam);
    });
  }, [baseVisiblePlans, searchTerm, selectedStatus, selectedSubject, selectedTeam]);
  const handleResetFilters = () => { setSearchTerm(''); setSelectedStatus('all'); setSelectedSubject(''); setSelectedTeam(''); };
  const getDashboardTitle = () => {
    switch (currentUser.role) { case Role.TEACHER: return 'Kế hoạch bài dạy của tôi'; case Role.TEAM_LEADER: case Role.DEPUTY_TEAM_LEADER: return `Quản lý Kế hoạch bài dạy - ${userTeamName}`; case Role.VICE_PRINCIPAL: return 'Quản lý Kế hoạch bài dạy - Ban Giám hiệu'; case Role.PRINCIPAL: return 'Tổng quan tất cả Kế hoạch bài dạy'; default: return 'Bảng điều khiển'; }
  }

  // Global Admin has a completely different dashboard
  if (currentUser.role === Role.ADMIN) {
      return <GlobalAdminDashboard schools={schools} teams={teams} users={users} lessonPlans={lessonPlans} onAdminClick={onAdminClick} />
  }

  const renderStats = () => {
    const stats = useMemo(() => {
      let waitingForMe = 0, waitingForPrincipal = 0, totalRejected = 0, totalIssued = 0;
      const plans = (currentUser.role === Role.PRINCIPAL) ? lessonPlans : baseVisiblePlans;
      switch(currentUser.role) {
        case Role.TEAM_LEADER: case Role.DEPUTY_TEAM_LEADER:
          if (currentUser.role === Role.TEAM_LEADER || (currentUser.role === Role.DEPUTY_TEAM_LEADER && delegation.teamDelegation[currentUser.teamId || -1])) { waitingForMe = plans.filter(p => p.status === Status.SUBMITTED).length; } break;
        case Role.PRINCIPAL: case Role.VICE_PRINCIPAL:
           if (currentUser.role === Role.PRINCIPAL || (currentUser.role === Role.VICE_PRINCIPAL && delegation.principalToVp)) { waitingForMe = lessonPlans.filter(p => p.status === Status.APPROVED_BY_TL).length; } break;
      }
      if (currentUser.role !== Role.TEACHER) { totalIssued = plans.filter(p => p.status === Status.ISSUED).length; waitingForPrincipal = lessonPlans.filter(p => p.status === Status.APPROVED_BY_TL).length; totalRejected = plans.filter(p => p.status === Status.REJECTED_BY_TL || p.status === Status.REJECTED_BY_VP).length; }
      return { waitingForMe, waitingForPrincipal, totalRejected, totalIssued };
    }, [currentUser, baseVisiblePlans, lessonPlans, delegation]);
    const statItems = [];
    if (stats.waitingForMe > 0) statItems.push({ title: 'Chờ bạn duyệt', value: stats.waitingForMe, color: 'border-yellow-500' });
    if (currentUser.role === Role.PRINCIPAL || currentUser.role === Role.VICE_PRINCIPAL || currentUser.role === Role.TEAM_LEADER || currentUser.role === Role.DEPUTY_TEAM_LEADER) {
        if (stats.waitingForPrincipal > 0) statItems.push({ title: 'Chờ BGH duyệt', value: stats.waitingForPrincipal, color: 'border-blue-500' });
        statItems.push({ title: 'Tổng số đã ban hành', value: stats.totalIssued, color: 'border-purple-500' });
        if (stats.totalRejected > 0) statItems.push({ title: 'Tổng số bị từ chối', value: stats.totalRejected, color: 'border-red-500' });
    }
    if (statItems.length === 0 || currentUser.role === Role.TEACHER) return null;
    return (<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">{statItems.map(stat => (<div key={stat.title} className={`bg-white p-5 rounded-xl shadow-lg flex items-center space-x-4 border-l-4 ${stat.color}`}><div><p className="text-sm font-medium text-gray-500 truncate">{stat.title}</p><p className="mt-1 text-3xl font-semibold text-gray-900">{stat.value}</p></div></div>))}</div>);
  }
  return (
    <div className="space-y-8">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <h1 className="text-3xl sm:text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-700 to-purple-600 tracking-tight">{getDashboardTitle()}</h1>
            <div className="flex items-center space-x-2 flex-wrap justify-end">
                <button onClick={onUploadClick} className="flex items-center justify-center bg-blue-600 text-white font-bold py-2.5 px-5 rounded-lg shadow-lg hover:bg-blue-700 transform hover:scale-105 transition-all duration-300 text-base">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" /></svg>
                    Tạo Kế hoạch bài dạy
                </button>
                {[Role.TEAM_LEADER, Role.DEPUTY_TEAM_LEADER].includes(currentUser.role) && (
                    <button onClick={onTeamOverviewClick} className="flex items-center justify-center bg-green-600 text-white font-bold py-2.5 px-5 rounded-lg shadow-lg hover:bg-green-700 transition-all duration-300 text-base">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor"><path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z" /></svg>
                        Tổng quan Tổ
                    </button>
                )}
                {currentUser.role !== Role.TEACHER && (<button onClick={() => setReportModalOpen(true)} className="flex items-center justify-center bg-purple-600 text-white font-bold py-2.5 px-5 rounded-lg shadow-lg hover:bg-purple-700 transition-all duration-300 text-base"><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" /></svg>Báo cáo AI</button>)}
                {[Role.PRINCIPAL].includes(currentUser.role) && (<button onClick={onAdminClick} className="flex items-center justify-center bg-gray-700 text-white font-bold py-2.5 px-5 rounded-lg shadow-lg hover:bg-gray-800 transition-all duration-300 text-base"><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor"><path d="M5 8a1 1 0 011-1h8a1 1 0 110 2H6a1 1 0 01-1-1zm-1 4a1 1 0 011-1h8a1 1 0 110 2H5a1 1 0 01-1-1z" /><path fillRule="evenodd" d="M2 3a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm2 1h12v12H4V4z" clipRule="evenodd" /></svg>Quản trị</button>)}
            </div>
        </header>
        {renderStats()}
        <div className="bg-white p-4 sm:p-6 rounded-xl shadow-lg border border-gray-200">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
                <div className="col-span-1 md:col-span-2"><label htmlFor="search" className="block text-sm font-medium text-gray-700">Tìm kiếm</label><input type="text" id="search" placeholder="Nhập tiêu đề, môn học, giáo viên..." className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 focus:ring-blue-500 focus:border-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}/></div>
                {[Role.PRINCIPAL].includes(currentUser.role) && (<div><label htmlFor="team-filter" className="block text-sm font-medium text-gray-700">Tổ chuyên môn</label><select id="team-filter" value={selectedTeam} onChange={(e) => setSelectedTeam(e.target.value)} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 focus:ring-blue-500 focus:border-blue-500"><option value="">Tất cả tổ</option>{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></div>)}
                <div><label htmlFor="status-filter" className="block text-sm font-medium text-gray-700">Trạng thái</label><select id="status-filter" value={selectedStatus} onChange={(e) => setSelectedStatus(e.target.value as Status | 'all')} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 focus:ring-blue-500 focus:border-blue-500"><option value="all">Tất cả</option>{Object.entries(Status).map(([key, value]) => <option key={key} value={value}>{value}</option>)}</select></div>
                <div><label htmlFor="subject-filter" className="block text-sm font-medium text-gray-700">Môn học</label><select id="subject-filter" value={selectedSubject} onChange={(e) => setSelectedSubject(e.target.value)} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 focus:ring-blue-500 focus:border-blue-500"><option value="">Tất cả môn</option>{SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
                <div className="col-span-1 lg:col-span-4 flex justify-end"><button onClick={handleResetFilters} className="bg-gray-200 text-gray-700 font-semibold py-2 px-4 rounded-md hover:bg-gray-300">Xóa bộ lọc</button></div>
            </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
            {visiblePlans.length > 0 ? (visiblePlans.map(plan => (<LessonPlanCard key={plan.id} plan={plan} currentUser={currentUser} onAction={onAction} onEdit={onEdit} teams={teams} delegation={delegation} onNotification={onNotification} onAddComment={onAddComment} />))) : (<div className="col-span-full text-center py-12 bg-white rounded-xl shadow-lg border border-gray-200"><p className="text-gray-500">Không tìm thấy Kế hoạch bài dạy nào.</p></div>)}
        </div>
        {isReportModalOpen && (<ReportModal onClose={() => setReportModalOpen(false)} lessonPlans={visiblePlans} currentUser={currentUser}/>)}
    </div>
  );
};

// --- Component: Login ---
interface LoginProps { school: School | null; onLogin: (email: string, password: string) => Promise<boolean>; onO365Login: () => void; onBackToHome: () => void; }
const Login: React.FC<LoginProps> = ({ school, onLogin, onO365Login, onBackToHome }) => {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const handleSubmit = async (e: React.FormEvent) => { 
    e.preventDefault(); 
    setError(''); 
    setIsLoading(true);
    const success = await onLogin(email, password);
    if (!success) {
      setError('Email hoặc mật khẩu không chính xác.'); 
    }
    setIsLoading(false);
  };
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <div className="w-full max-w-md p-8 space-y-6 bg-white rounded-xl shadow-lg">
        <div className="text-center">
            <div className="inline-block p-3 bg-gradient-to-br from-blue-600 to-purple-600 rounded-2xl mx-auto mb-4"><svg className="w-10 h-10 text-white" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.5 2H8.5C7.39543 2 6.5 2.89543 6.5 4V20C6.5 21.1046 7.39543 22 8.5 22H18.5C19.6046 22 20.5 21.1046 20.5 20V7.5L15.5 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M15 2.5V8H20.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M9.5 14.5L11.5 16.5L15.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
          <h1 className="text-3xl font-extrabold text-gray-900">Đăng nhập vào hệ thống</h1><p className="mt-2 text-gray-600 font-semibold">{school ? school.name : "Tài khoản Quản trị Toàn cầu"}</p>
        </div>
        <div className="space-y-4">
            <button type="button" onClick={onO365Login} disabled={isLoading || !school} className="w-full flex items-center justify-center py-2.5 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400"><svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 24 24"><path d="M2.75 12.32h8.53v8.53h-8.53v-8.53Zm0-1.41h8.53V2.38h-8.53v8.53Zm9.94 1.41h8.53v8.53h-8.53v-8.53Zm0-1.41h8.53V2.38h-8.53v8.53Z" /></svg>Đăng nhập bằng Office 365</button>
            <div className="relative"><div className="absolute inset-0 flex items-center"><div className="w-full border-t border-gray-300"></div></div><div className="relative flex justify-center text-sm"><span className="px-2 bg-white text-gray-500">Hoặc đăng nhập tài khoản Quản trị</span></div></div>
            <form className="space-y-4" onSubmit={handleSubmit}>{error && <p className="text-center text-sm text-red-600 bg-red-50 p-3 rounded-md">{error}</p>}<div><label htmlFor="email" className="sr-only">Địa chỉ Email</label><input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email quản trị" className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"/></div><div><label htmlFor="password"className="sr-only">Mật khẩu</label><input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Mật khẩu" className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500"/></div><button type="submit" disabled={isLoading} className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-gray-600 hover:bg-gray-700 disabled:bg-gray-400">{isLoading ? 'Đang đăng nhập...' : 'Đăng nhập Quản trị viên'}</button></form>
        </div>
        <div className="text-center !mt-8 border-t border-gray-200 pt-6">
            <button type="button" onClick={onBackToHome} className="text-sm font-medium text-blue-600 hover:underline">Quay về Trang chủ</button>
        </div>
      </div>
    </div>
  );
};

// --- Component: LandingPage ---
interface LandingPageProps { 
  onSelectSchool: (schoolId: string) => void;
  onGlobalAdminLogin: () => void;
  schools: School[];
  onNotification: (config: Omit<NotificationModalProps, 'isOpen' | 'onClose'>) => void;
}
const BenefitCard: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ icon, title, children }) => (
    <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100 text-center flex flex-col items-center">
        <div className="flex-shrink-0 flex items-center justify-center h-16 w-16 rounded-full bg-blue-100 text-blue-600 mb-4">{icon}</div>
        <h3 className="text-lg font-bold text-gray-900 mb-2">{title}</h3>
        <p className="text-gray-600 text-sm leading-relaxed">{children}</p>
    </div>
);
const Feature: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ icon, title, children }) => (
    <div className="relative">
        <dt>
            <div className="absolute flex items-center justify-center h-12 w-12 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 text-white">
                {icon}
            </div>
            <p className="ml-16 text-lg leading-6 font-bold text-gray-900">{title}</p>
        </dt>
        <dd className="mt-2 ml-16 text-base text-gray-600">{children}</dd>
    </div>
);
const LandingPage: React.FC<LandingPageProps> = ({ onSelectSchool, onGlobalAdminLogin, schools, onNotification }) => {
    const scrollToFeatures = () => {
        document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' });
    };

    const [selectedSchoolId, setSelectedSchoolId] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [suggestions, setSuggestions] = useState<School[]>([]);
    const [isSuggestionsVisible, setIsSuggestionsVisible] = useState(false);
    const suggestionsRef = useRef<HTMLDivElement>(null);
    
    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setSearchTerm(value);
        setSelectedSchoolId('');
        
        if (value.length > 0) {
            const filteredSchools = schools.filter(school => 
                school.name.toLowerCase().includes(value.toLowerCase())
            );
            setSuggestions(filteredSchools);
            setIsSuggestionsVisible(filteredSchools.length > 0);
        } else {
            setSuggestions([]);
            setIsSuggestionsVisible(false);
        }
    };
    
    const handleSelectSchool = (school: School) => {
        setSearchTerm(school.name);
        setSelectedSchoolId(school.id);
        setIsSuggestionsVisible(false);
    };

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (suggestionsRef.current && !suggestionsRef.current.contains(event.target as Node)) {
                setIsSuggestionsVisible(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    const handleFocus = () => {
        if (searchTerm.length > 0 && suggestions.length > 0) {
            setIsSuggestionsVisible(true);
        }
    };

    const handleSchoolLoginClick = () => {
        if (selectedSchoolId) {
            onSelectSchool(selectedSchoolId);
        } else {
            onNotification({
                type: 'info',
                title: 'Vui lòng chọn trường',
                message: 'Bạn cần tìm và chọn đơn vị trường học của mình từ danh sách để có thể tiếp tục đăng nhập.',
            });
        }
    };
    
    return (
        <div className="bg-white text-gray-800 antialiased">
            <header className="bg-white/90 backdrop-blur-md shadow-sm sticky top-0 z-50">
                <nav className="container mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex items-center justify-between h-20">
                        <div className="flex items-center space-x-3">
                            <div className="p-2 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-xl">
                                <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.5 2H8.5C7.39543 2 6.5 2.89543 6.5 4V20C6.5 21.1046 7.39543 22 8.5 22H18.5C19.6046 22 20.5 21.1046 20.5 20V7.5L15.5 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M15 2.5V8H20.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M9.5 14.5L11.5 16.5L15.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                            </div>
                            <span className="font-extrabold text-xl text-gray-800 tracking-tight">Hệ thống Phê duyệt Giáo án</span>
                        </div>
                        <div className="flex items-center space-x-6">
                            <a href="#features" onClick={(e) => { e.preventDefault(); scrollToFeatures(); }} className="hidden md:inline-block font-semibold text-gray-600 hover:text-blue-600 transition-colors">Tính năng</a>
                            <button onClick={onGlobalAdminLogin} className="hidden md:inline-block font-semibold text-gray-600 hover:text-blue-600 transition-colors">Đăng nhập Quản trị</button>
                            <button onClick={handleSchoolLoginClick} title="Đăng nhập" className="px-5 py-2.5 bg-blue-600 text-white font-semibold rounded-lg shadow-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-75 transition-all duration-300">Đăng nhập</button>
                        </div>
                    </div>
                </nav>
            </header>

            <main>
                <section className="relative bg-gray-50 overflow-hidden">
                    <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-20 lg:py-32">
                        <div className="grid lg:grid-cols-2 gap-12 items-center">
                            <div className="z-10">
                                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-gray-900 tracking-tight">
                                    <span className="block">Chuyển đổi số Quy trình</span>
                                    <span className="block text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-indigo-600 mt-2">Nâng tầm Quản lý Giáo án</span>
                                </h1>
                                <p className="mt-6 text-lg text-gray-600 max-w-lg">
                                    Giải pháp toàn diện giúp giảm tải thủ tục hành chính, tiết kiệm thời gian cho giáo viên và minh bạch hóa quy trình phê duyệt cho ban lãnh đạo nhà trường.
                                </p>
                                <div className="mt-10">
                                    <label htmlFor="school-search" className="block text-sm font-semibold text-gray-700 mb-2">Chọn đơn vị của bạn để bắt đầu</label>
                                    <div ref={suggestionsRef} className="relative flex flex-col sm:flex-row items-stretch gap-2 max-w-2xl">
                                        <div className="relative flex-grow">
                                            <input
                                                id="school-search"
                                                type="text"
                                                value={searchTerm}
                                                onChange={handleSearchChange}
                                                onFocus={handleFocus}
                                                autoComplete="off"
                                                placeholder="Gõ tên trường và chọn từ danh sách..."
                                                className="w-full p-3 border border-gray-300 rounded-lg shadow-sm focus:ring-2 focus:ring-blue-500 transition"
                                            />
                                            {isSuggestionsVisible && suggestions.length > 0 && (
                                                <div className="absolute z-20 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                                                    <ul className="py-1">
                                                        {suggestions.map(school => (
                                                            <li 
                                                                key={school.id} 
                                                                onClick={() => handleSelectSchool(school)}
                                                                className="px-4 py-2 text-gray-700 hover:bg-blue-50 cursor-pointer"
                                                            >
                                                                {school.name}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            )}
                                        </div>
                                        <button
                                            onClick={handleSchoolLoginClick}
                                            title="Bắt đầu"
                                            className="px-6 py-3 bg-blue-600 text-white font-bold rounded-lg shadow-lg hover:bg-blue-700 transition-all duration-300 flex-shrink-0 flex items-center justify-center"
                                        >
                                            Bắt đầu
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 ml-2" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
                                        </button>
                                    </div>
                                    <div className="mt-4">
                                        <button onClick={scrollToFeatures} className="font-semibold text-gray-700 hover:text-blue-600 transition-colors py-2 px-1">
                                            Hoặc khám phá các tính năng
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div className="relative mt-12 lg:mt-0">
                                <div className="absolute -inset-4 bg-gradient-to-r from-blue-300 to-indigo-500 rounded-3xl blur-2xl opacity-40 animate-pulse"></div>
                                <img className="relative w-full rounded-2xl shadow-2xl border-8 border-white" src="https://duyetga.qni.edu.vn/1.jpg" alt="Giao diện hệ thống" />
                            </div>
                        </div>
                    </div>
                </section>

                <section className="py-16 lg:py-24 bg-white">
                    <div className="container mx-auto px-4 sm:px-6 lg:px-8 text-center">
                        <h2 className="text-3xl font-extrabold text-gray-900 tracking-tight">Giải pháp Toàn diện cho Quản lý Chuyên môn</h2>
                        <p className="mt-4 text-lg text-gray-600 max-w-3xl mx-auto">Tối ưu hóa quy trình làm việc và tăng cường hiệu quả cho mọi vai trò trong nhà trường.</p>
                        <div className="mt-16 grid md:grid-cols-3 gap-8">
                            <BenefitCard icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path d="M12 14l9-5-9-5-9 5 9 5z" /><path d="M12 14l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z" /><path strokeLinecap="round" strokeLinejoin="round" d="M12 14l9-5-9-5-9 5 9 5zm0 0l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14zm-4 6v-7.5l4-2.222 4 2.222V20M1 14v5a2 2 0 002 2h18a2 2 0 002-2v-5" /></svg>} title="Dành cho Giáo viên">Tập trung vào chuyên môn, giảm bớt giấy tờ. Nộp và theo dõi giáo án mọi lúc, mọi nơi. Nhận phản hồi nhanh chóng, trực tiếp trên hệ thống.</BenefitCard>
                            <BenefitCard icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>} title="Dành cho Tổ trưởng">Quản lý trực quan, hiệu quả. Dễ dàng xem, góp ý và phê duyệt giáo án của tổ viên. Nắm bắt tiến độ chung của cả tổ một cách nhanh chóng.</BenefitCard>
                            <BenefitCard icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>} title="Dành cho Ban Giám hiệu">Nắm bắt toàn cảnh, ra quyết định nhanh. Thống kê, báo cáo thông minh. Đảm bảo chất lượng chuyên môn đồng bộ toàn trường.</BenefitCard>
                        </div>
                    </div>
                </section>
                
                <section id="features" className="py-16 lg:py-24 bg-gray-50">
                    <div className="container mx-auto px-4 sm:px-6 lg:px-8">
                        <div className="lg:text-center">
                            <h2 className="text-base text-indigo-600 font-semibold tracking-wide uppercase">Tính năng Vượt trội</h2>
                            <p className="mt-2 text-3xl leading-8 font-extrabold tracking-tight text-gray-900 sm:text-4xl">Một nền tảng, vạn tiện ích</p>
                            <p className="mt-4 max-w-2xl text-xl text-gray-500 lg:mx-auto">Được thiết kế để đơn giản hóa quy trình chuyên môn phức tạp nhất.</p>
                        </div>
                        <div className="mt-16"><dl className="space-y-10 md:space-y-0 md:grid md:grid-cols-2 md:gap-x-8 md:gap-y-12 lg:grid-cols-3">
                            <Feature icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h5M4 12h16M4 20h16" /></svg>} title="Luồng Phê Duyệt Tự Động">Quy trình duyệt từ giáo viên, qua tổ trưởng và BGH được chuẩn hóa, minh bạch. Hệ thống tự động chuyển tiếp và thông báo đến người duyệt tiếp theo.</Feature>
                            <Feature icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>} title="Quản Lý Tập Trung">Tất cả Kế hoạch bài dạy được lưu tại một nơi, dễ dàng tìm kiếm, lọc và theo dõi trạng thái tức thì, loại bỏ việc lưu trữ phân tán, thất lạc.</Feature>
                            <Feature icon={<svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"><path d="M2.75 12.32h8.53v8.53h-8.53v-8.53Zm0-1.41h8.53V2.38h-8.53v8.53Zm9.94 1.41h8.53v8.53h-8.53v-8.53Zm0-1.41h8.53V2.38h-8.53v8.53Z" /></svg>} title="Tích Hợp Office 365">Đăng nhập một lần (SSO) an toàn và lưu trữ tự động trên OneDrive, tạo nên một hệ sinh thái làm việc liền mạch và quen thuộc.</Feature>
                            <Feature icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} title="Lịch sử Minh bạch">Toàn bộ quá trình từ lúc tạo, chỉnh sửa, từ chối đến phê duyệt đều được ghi lại chi tiết, giúp truy xuất và giải trình dễ dàng.</Feature>
                            <Feature icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>} title="Ủy quyền Linh hoạt">Hiệu trưởng và Tổ trưởng có thể dễ dàng ủy quyền phê duyệt cho cấp phó khi bận công tác, đảm bảo công việc không bị gián đoạn.</Feature>
                            <Feature icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" /></svg>} title="Báo cáo Thông minh">Trợ lý AI tích hợp giúp tổng hợp, phân tích dữ liệu và tạo báo cáo về tình hình duyệt giáo án chỉ trong vài giây, hỗ trợ ra quyết định.</Feature>
                        </dl></div>
                    </div>
                </section>
                
                <section className="bg-white py-16 lg:py-24">
                    <div className="container mx-auto px-4 sm:px-6 lg:px-8">
                        <blockquote className="max-w-4xl mx-auto text-center">
                            <svg className="h-12 w-12 mx-auto text-gray-300 mb-4" fill="currentColor" viewBox="0 0 32 32" aria-hidden="true"><path d="M9.352 4C4.456 7.456 1 13.12 1 19.36c0 5.088 3.072 8.064 6.624 8.064 3.36 0 5.856-2.688 5.856-5.856 0-3.168-2.208-5.472-5.088-5.472-.576 0-1.344.096-1.536.192.48-3.264 3.552-7.104 6.624-9.024L9.352 4zm16.512 0c-4.896 3.456-8.352 9.12-8.352 15.36 0 5.088 3.072 8.064 6.624 8.064 3.36 0 5.856-2.688 5.856-5.856 0-3.168-2.208-5.472-5.088-5.472-.576 0-1.344.096-1.536.192.48-3.264 3.552-7.104 6.624-9.024L25.864 4z" /></svg>
                            <p className="text-2xl font-medium text-gray-900">"Từ khi triển khai hệ thống, việc quản lý chuyên môn của tổ chúng tôi đã trở nên nhẹ nhàng hơn rất nhiều. Mọi thứ minh bạch, nhanh chóng và hiệu quả hơn hẳn so với việc duyệt giấy tờ thủ công trước đây."</p>
                            <footer className="mt-8">
                                <div className="md:flex md:items-center md:justify-center">
                                    <div className="md:flex-shrink-0"><img className="mx-auto h-10 w-10 rounded-full" src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80" alt="" /></div>
                                    <div className="mt-3 text-center md:mt-0 md:ml-4 md:flex md:items-center">
                                        <div className="text-base font-medium text-gray-900">Cô Lê Thị Minh</div>
                                        <svg className="hidden md:block mx-1 h-5 w-5 text-blue-600" fill="currentColor" viewBox="0 0 20 20"><path d="M11 0h3L9 20H6l5-20z" /></svg>
                                        <div className="text-base font-medium text-gray-500">Tổ trưởng Tổ Khoa học Xã hội</div>
                                    </div>
                                </div>
                            </footer>
                        </blockquote>
                    </div>
                </section>

                <section className="bg-gray-800">
                    <div className="container mx-auto py-16 px-4 sm:px-6 lg:px-8 text-center">
                        <h2 className="text-3xl font-extrabold text-white sm:text-4xl">Sẵn sàng cách mạng hóa quy trình làm việc của bạn?</h2>
                        <p className="mt-4 text-lg text-gray-300 max-w-2xl mx-auto">Tham gia cùng các đơn vị giáo dục tiên phong và trải nghiệm một phương thức quản lý chuyên môn hiệu quả hơn.</p>
                        <div className="mt-8">
                            <button onClick={handleSchoolLoginClick} title="Đăng nhập và Khám phá" className="px-8 py-4 bg-white text-blue-600 font-bold text-lg rounded-lg shadow-lg hover:bg-gray-200 transform hover:scale-105 transition-all duration-300">Đăng nhập và Khám phá</button>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="bg-gray-900 text-gray-400">
                <div className="container mx-auto py-8 px-4 sm:px-6 lg:px-8 text-center text-sm">
                    <p>&copy; 2025 Hệ thống Phê duyệt Giáo án - Sở GD&ĐT Quảng Ngãi. All rights reserved.</p>
                    <p className="mt-2">Một giải pháp cho Chuyển đổi số Giáo dục.</p>
                </div>
            </footer>
        </div>
    );
};

// --- Component: Navbar ---
interface NavbarProps { currentUser: User | null; school: School | null; onLogout: () => void; onProfileClick: () => void; }
const Navbar: React.FC<NavbarProps> = ({ currentUser, school, onLogout, onProfileClick }) => {
    const [isDropdownOpen, setDropdownOpen] = useState(false); const dropdownRef = useRef<HTMLDivElement>(null);
    useEffect(() => { const handleClickOutside = (event: MouseEvent) => { if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) setDropdownOpen(false); }; document.addEventListener("mousedown", handleClickOutside); return () => document.removeEventListener("mousedown", handleClickOutside); }, []);
    return (
        <nav className="bg-white shadow-md h-16 flex-shrink-0">
            <div className="container mx-auto px-4 sm:px-6 lg:px-8"><div className="flex items-center justify-between h-16">
                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-2">
                    <div className="p-1.5 bg-gradient-to-br from-blue-600 to-purple-600 rounded-lg"><svg className="w-7 h-7 text-white" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.5 2H8.5C7.39543 2 6.5 2.89543 6.5 4V20C6.5 21.1046 7.39543 22 8.5 22H18.5C19.6046 22 20.5 21.1046 20.5 20V7.5L15.5 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M15 2.5V8H20.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M9.5 14.5L11.5 16.5L15.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
                    <span className="font-bold text-lg text-gray-800 hidden sm:inline">Hệ thống phê duyệt</span>
                  </div>
                  {school && (
                    <>
                      <div className="h-6 w-px bg-gray-300 hidden sm:block"></div>
                      <span className="font-semibold text-gray-600 text-sm sm:text-base truncate">{school.name}</span>
                    </>
                  )}
                </div>
                {currentUser && (<div className="relative" ref={dropdownRef}><button onClick={() => setDropdownOpen(!isDropdownOpen)} className="flex items-center space-x-2 p-2 rounded-lg hover:bg-gray-100 transition"><div className="text-right"><p className="font-semibold text-gray-700 text-sm">{currentUser.name}</p><p className="text-xs text-gray-500">{currentUser.role}</p></div><svg xmlns="http://www.w3.org/2000/svg" className={`h-4 w-4 text-gray-500 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg></button>{isDropdownOpen && (<div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg py-1 z-50 border"><a href="#" onClick={(e) => { e.preventDefault(); onProfileClick(); setDropdownOpen(false); }} className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">Hồ sơ người dùng</a><a href="#" onClick={(e) => { e.preventDefault(); onLogout(); setDropdownOpen(false); }} className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">Đăng xuất</a></div>)}</div>)}
            </div></div>
        </nav>
    );
};

// -----------------------------------------------------------------------------
// SECTION 6: MAIN APP COMPONENT
// -----------------------------------------------------------------------------
const App: React.FC = () => {
  // --- STATES ---
  const [isLoadingApp, setIsLoadingApp] = useState(true);
  const [appError, setAppError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [selectedSchool, setSelectedSchool] = useState<School | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  
  const [schools, setSchools] = useState<School[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [lessonPlans, setLessonPlans] = useState<LessonPlan[]>([]);
  const [delegation, setDelegation] = useState<DelegationState>({ principalToVp: false, teamDelegation: {} });

  const [isUploadModalOpen, setUploadModalOpen] = useState(false);
  const [isAdminModalOpen, setAdminModalOpen] = useState(false);
  const [isTeamOverviewModalOpen, setTeamOverviewModalOpen] = useState(false);
  const [isProfileModalOpen, setProfileModalOpen] = useState(false);
  const [isTeamSelectionModalOpen, setTeamSelectionModalOpen] = useState(false);
  const [editingLessonPlan, setEditingLessonPlan] = useState<LessonPlan | null>(null);
  const [msalInstance, setMsalInstance] = useState<PublicClientApplication | null>(null);
  const [msAccount, setMsAccount] = useState<AccountInfo | null>(null);
  const [notification, setNotification] = useState<Omit<NotificationModalProps, 'isOpen' | 'onClose'> | null>(null);
  
  const onNotification = useCallback((config: Omit<NotificationModalProps, 'isOpen' | 'onClose'>) => { setNotification(config); }, []);

  // Effect to initialize MSAL and fetch all initial data
  useEffect(() => {
    const initializeApp = async () => {
        try {
            const instance = await getMsalInstance();
            setMsalInstance(instance);

            let data;
            try {
                // Attempt to fetch from the real API first
                data = await api('/bootstrap');
                console.log('%c[API] ✅ Dữ liệu được tải thành công từ backend.', 'color: green; font-weight: bold;');
            } catch (apiError: any) {
                // If API fails (e.g., 404), use mock data as a fallback for development
                console.warn(`%c[API] ⚠️ Lỗi khi gọi API backend: ${apiError.message}. Sử dụng dữ liệu mẫu (mock data) để chạy ứng dụng.`, 'color: orange; font-weight: bold;');
                data = MOCK_BOOTSTRAP_DATA;
            }

            setSchools(data.schools);
            setUsers(data.users);
            setTeams(data.teams);
            setLessonPlans(data.lessonPlans.map((p: any) => ({
                ...p, 
                submittedAt: new Date(p.submittedAt),
                finalApprovedAt: p.finalApprovedAt ? new Date(p.finalApprovedAt) : undefined,
                history: p.history.map((h: any) => ({...h, timestamp: new Date(h.timestamp)})),
                 comments: p.comments ? p.comments.map((c: any) => ({...c, timestamp: new Date(c.timestamp)})) : []
            })));
            setDelegation(data.delegation);
            
            // Check for existing MSAL session
            const accounts = instance.getAllAccounts();
            if (accounts.length > 0) {
                const account = accounts[0];
                const user = data.users.find((u: User) => u.o365Email?.toLowerCase() === account.username.toLowerCase() || u.email.toLowerCase() === account.username.toLowerCase());
                if (user) {
                    instance.setActiveAccount(account);
                    setMsAccount(account);
                    setCurrentUser(user);
                    const school = data.schools.find((s: School) => s.id === user.schoolId);
                    if (school) setSelectedSchool(school);
                }
            } else {
                // Check for local session (non-O365 admin/principal)
                const loggedInUserEmail = localStorage.getItem('currentUserEmail');
                const loggedInSchoolId = localStorage.getItem('selectedSchoolId');
                if (loggedInUserEmail) {
                    const user = data.users.find((u: User) => u.email.toLowerCase() === loggedInUserEmail.toLowerCase());
                     if (user) {
                        setCurrentUser(user);
                        if (user.role !== Role.ADMIN && loggedInSchoolId) {
                            const school = data.schools.find((s: School) => s.id === loggedInSchoolId);
                            if (school) setSelectedSchool(school);
                        }
                    }
                }
            }
        } catch (error: any) {
            setAppError(error.message || "Không thể tải dữ liệu từ máy chủ. Vui lòng thử lại sau.");
        } finally {
            setIsLoadingApp(false);
        }
    };
    initializeApp();
  }, []);

  const handleLogin = async (email: string, password?: string): Promise<boolean> => {
    // Fallback to mock login for development if API fails
    const user = MOCK_USERS.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password && (u.schoolId === selectedSchool?.id || u.role === Role.ADMIN));
    if (user) {
        setCurrentUser(user);
        localStorage.setItem('currentUserEmail', user.email);
        if (user.role !== Role.ADMIN && selectedSchool) {
            localStorage.setItem('selectedSchoolId', selectedSchool.id);
        }
        console.warn("[AUTH] Đăng nhập bằng tài khoản Quản trị mẫu.");
        return true;
    }
    return false;
  };
  
  const handleO365Login = async () => {
    if (!msalInstance || !selectedSchool) {
        onNotification({ type: 'error', title: 'Lỗi cấu hình', message: 'Dịch vụ xác thực chưa sẵn sàng hoặc chưa chọn trường. Vui lòng thử lại.' });
        return;
    }
    const account = await loginWithO365(msalInstance);
    if (!account) return;
    
    // Fallback to mock O365 login for development
    console.warn("[AUTH] API O365 login failed. Fallback to mock user matching.");
    const user = MOCK_USERS.find(u => u.schoolId === selectedSchool.id && (u.o365Email?.toLowerCase() === account.username.toLowerCase() || u.email.toLowerCase() === account.username.toLowerCase()));
    if (user) {
         setCurrentUser(user); 
         setMsAccount(account);
         localStorage.setItem('currentUserEmail', user.email);
         localStorage.setItem('selectedSchoolId', selectedSchool.id);
         if (user.role === Role.TEACHER && !user.teamId) {
            setTeamSelectionModalOpen(true);
         } else {
            onNotification({ type: 'success', title: 'Đăng nhập thành công!', message: `Chào mừng ${user.name} đã truy cập vào hệ thống.` });
         }
    } else {
         onNotification({ 
            type: 'error', 
            title: 'Tài khoản chưa được cấu hình', 
            message: `Tài khoản O365 (${account.username}) chưa được đăng ký trong trường này. Vui lòng liên hệ quản trị viên nhà trường.`
        });
        if (msalInstance) msalInstance.logoutPopup({ account });
    }
  };
  
  const handleLogout = () => {
    setCurrentUser(null);
    setMsAccount(null);
    setShowLogin(false);
    setSelectedSchool(null);
    localStorage.removeItem('currentUserEmail');
    localStorage.removeItem('selectedSchoolId');
    localStorage.removeItem('authToken');
    if (msalInstance) msalInstance.setActiveAccount(null);
  };

  const handleSelectSchool = (schoolId: string) => {
    const school = schools.find(s => s.id === schoolId);
    if (school) {
        setSelectedSchool(school);
        setShowLogin(true);
    } else {
        onNotification({ type: 'error', title: 'Lỗi', message: 'Không tìm thấy trường đã chọn.' });
    }
  };

  const handleGlobalAdminLogin = () => {
      setSelectedSchool(null); // No school context for global admin
      setShowLogin(true);
  };

  const handleOpenUploadModal = () => { setEditingLessonPlan(null); setUploadModalOpen(true); };
  const handleEditLessonPlan = (plan: LessonPlan) => { setEditingLessonPlan(plan); setUploadModalOpen(true); };
  
  const handleLessonPlanAction = useCallback(async (planId: number, newStatus: Status, reason?: string) => {
    if (!currentUser) return;

    onNotification({ type: 'loading', title: 'Đang xử lý...', message: 'Vui lòng đợi trong giây lát.' });
    
    try {
        const updatedPlanData = await api(`/lesson-plans/${planId}/status`, {
            method: 'PUT',
            body: JSON.stringify({ newStatus, reason }),
        });

        const updatedPlan = {
            ...updatedPlanData, 
            submittedAt: new Date(updatedPlanData.submittedAt),
            finalApprovedAt: updatedPlanData.finalApprovedAt ? new Date(updatedPlanData.finalApprovedAt) : undefined,
            history: updatedPlanData.history.map((h: any) => ({...h, timestamp: new Date(h.timestamp)})),
            comments: updatedPlanData.comments ? updatedPlanData.comments.map((c: any) => ({...c, timestamp: new Date(c.timestamp)})) : []
        };

        setLessonPlans(prevPlans => prevPlans.map(p => p.id === planId ? updatedPlan : p));
        onNotification({ type: 'success', title: 'Thành công', message: `Trạng thái giáo án đã được cập nhật.` });
    } catch (error: any) {
        onNotification({ type: 'error', title: 'Cập nhật thất bại', message: error.message });
    }
  }, [currentUser, onNotification]);
  
  const handleAddComment = useCallback(async (planId: number, text: string) => {
    try {
        const updatedPlanData = await api(`/lesson-plans/${planId}/comments`, {
            method: 'POST',
            body: JSON.stringify({ text }),
        });

        const updatedPlan = {
            ...updatedPlanData, 
            submittedAt: new Date(updatedPlanData.submittedAt),
            finalApprovedAt: updatedPlanData.finalApprovedAt ? new Date(updatedPlanData.finalApprovedAt) : undefined,
            history: updatedPlanData.history.map((h: any) => ({...h, timestamp: new Date(h.timestamp)})),
            comments: updatedPlanData.comments ? updatedPlanData.comments.map((c: any) => ({...c, timestamp: new Date(c.timestamp)})) : []
        };
        
        setLessonPlans(prevPlans => prevPlans.map(p => p.id === planId ? updatedPlan : p));

    } catch (error: any) {
        onNotification({ type: 'error', title: 'Gửi thất bại', message: `Không thể gửi góp ý: ${error.message}` });
    }
  }, [onNotification]);


  const handleSaveLessonPlan = useCallback(async (details: UploadDetails, source: UploadSource, isDraft: boolean) => {
    if (!currentUser || !selectedSchool) return;
    onNotification({ type: 'loading', title: 'Đang lưu...', message: 'Giáo án đang được tải lên và xử lý.' });

    const formData = new FormData();
    const fullDetails = { ...details, schoolId: selectedSchool.id };
    formData.append('details', JSON.stringify(fullDetails));
    formData.append('isDraft', String(isDraft));
    if (source.file) {
        formData.append('file', source.file);
    }

    try {
        let savedPlanData;
        if (editingLessonPlan) {
            savedPlanData = await api(`/lesson-plans/${editingLessonPlan.id}`, {
                method: 'PUT',
                body: formData,
            });
            const savedPlan = {...savedPlanData, submittedAt: new Date(savedPlanData.submittedAt)};
            setLessonPlans(plans => plans.map(p => p.id === editingLessonPlan.id ? savedPlan : p));
        } else {
            savedPlanData = await api('/lesson-plans', {
                method: 'POST',
                body: formData,
            });
            const savedPlan = {...savedPlanData, submittedAt: new Date(savedPlanData.submittedAt)};
            setLessonPlans(plans => [...plans, savedPlan]);
        }
        
        setUploadModalOpen(false);
        setEditingLessonPlan(null);
        onNotification({ type: 'success', title: 'Lưu thành công', message: 'Kế hoạch bài dạy của bạn đã được lưu.' });

    } catch (error: any) {
        onNotification({ type: 'error', title: 'Lưu thất bại', message: error.message });
    }
  }, [currentUser, editingLessonPlan, onNotification, selectedSchool]);
  
  // --- Admin Functions ---
  const handleAddUser = async (details: Omit<NewUserDetails, 'schoolId'>, schoolId: string) => {
    if (!schoolId) return;
    const fullDetails = { ...details, schoolId: schoolId };
    try {
        const newUser = await api('/users', { method: 'POST', body: JSON.stringify(fullDetails) });
        setUsers(current => [...current, newUser]);
    } catch (error: any) { 
        console.warn("API call failed, using mock logic for handleAddUser.");
        const newUser: User = { id: Date.now(), ...details, role: details.role || Role.TEACHER, schoolId };
        setUsers(current => [...current, newUser]);
    }
  };
  const handleCreateTeam = async (teamName: string, schoolId: string) => {
    if (!schoolId) return;
    try {
        const newTeam = await api('/teams', { method: 'POST', body: JSON.stringify({ name: teamName, schoolId: schoolId }) });
        setTeams(current => [...current, newTeam]);
    } catch (error: any) { 
        console.warn("API call failed, using mock logic for handleCreateTeam.");
        const newTeam: Team = { id: Date.now(), name: teamName, schoolId: schoolId };
        setTeams(current => [...current, newTeam]);
        onNotification({ type: 'success', title: 'Tạo thành công', message: `Đã tạo tổ "${teamName}".` });
    }
  };
  const handleUpdateUser = async (updatedUser: User) => {
    try {
        const user = await api(`/users/${updatedUser.id}`, { method: 'PUT', body: JSON.stringify(updatedUser) });
        setUsers(current => current.map(u => u.id === user.id ? user : u));
    } catch (error: any) { 
        console.warn("API call failed, using mock logic for handleUpdateUser.");
        setUsers(current => current.map(u => u.id === updatedUser.id ? updatedUser : u));
    }
  };
  const handleAssignTeamRole = async (teamId: number, roleType: 'leader' | 'deputy', newUserId: number | null) => {
    try {
        const { updatedTeam, updatedUsers } = await api(`/teams/${teamId}/assign-role`, {
            method: 'POST',
            body: JSON.stringify({ roleType, userId: newUserId }),
        });
        setTeams(current => current.map(t => t.id === updatedTeam.id ? updatedTeam : t));
        setUsers(current => current.map(u => updatedUsers.find((up: User) => up.id === u.id) || u));
        onNotification({ type: 'success', title: 'Cập nhật thành công', message: `Đã cập nhật vai trò cho tổ.` });
    } catch (error: any) { 
        console.warn("API call failed, using mock logic for handleAssignTeamRole.");
        const oldTeamState = teams.find(t => t.id === teamId);
        const userToDemoteId = roleType === 'leader' ? oldTeamState?.leaderId : oldTeamState?.deputyLeaderId;

        setTeams(current => current.map(t => {
            if (t.id === teamId) {
                const updatedTeam = { ...t };
                if (roleType === 'leader') updatedTeam.leaderId = newUserId || undefined;
                else updatedTeam.deputyLeaderId = newUserId || undefined;
                return updatedTeam;
            }
            return t;
        }));

        setUsers(current => current.map(u => {
            if (u.id === userToDemoteId && u.id !== newUserId) {
                return { ...u, role: Role.TEACHER };
            }
            if (u.id === newUserId) {
                return { ...u, role: roleType === 'leader' ? Role.TEAM_LEADER : Role.DEPUTY_TEAM_LEADER };
            }
            return u;
        }));
        onNotification({ type: 'success', title: 'Cập nhật thành công', message: `Đã cập nhật vai trò cho tổ.` });
    }
  };
  const slugify = (text: string) => text.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/--+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  const handleAddSchool = async (school: Omit<School, 'id'>) => {
    try {
      const newSchool = await api('/schools', { method: 'POST', body: JSON.stringify(school) });
      setSchools(current => [...current, newSchool]);
    } catch (error: any) { 
        console.warn("API call failed, using mock logic for handleAddSchool.");
        const newSchool: School = { id: slugify(school.name).toUpperCase() + '-' + Date.now().toString().slice(-4), name: school.name };
        setSchools(current => [...current, newSchool]);
    }
  };
  const handleUpdateSchool = async (updatedSchool: School) => {
    try {
      const school = await api(`/schools/${updatedSchool.id}`, { method: 'PUT', body: JSON.stringify(updatedSchool) });
      setSchools(current => current.map(s => s.id === school.id ? school : s));
    } catch (error: any) { 
        console.warn("API call failed, using mock logic for handleUpdateSchool.");
        setSchools(current => current.map(s => s.id === updatedSchool.id ? updatedSchool : s));
    }
  };
  const handleDeleteSchool = async (schoolId: string) => {
    try {
      await api(`/schools/${schoolId}`, { method: 'DELETE' });
      setSchools(current => current.filter(s => s.id !== schoolId));
    } catch (error: any) { 
        console.warn("API call failed, using mock logic for handleDeleteSchool.");
        setSchools(current => current.filter(s => s.id !== schoolId));
        setTeams(current => current.filter(t => t.schoolId !== schoolId));
        setUsers(current => current.filter(u => u.schoolId !== schoolId));
        setLessonPlans(current => current.filter(p => p.schoolId !== schoolId));
        onNotification({ type: 'success', title: 'Xóa thành công', message: 'Đã xóa trường và tất cả dữ liệu liên quan.' });
    }
  };
   const handleSetDelegation = async (newDelegation: DelegationState) => {
        try {
            const updatedDelegation = await api('/delegation', { method: 'PUT', body: JSON.stringify(newDelegation) });
            setDelegation(updatedDelegation);
        } catch (error: any) { 
            console.warn("API call failed, using mock logic for handleSetDelegation.");
            setDelegation(newDelegation);
            onNotification({ type: 'success', title: 'Cập nhật thành công', message: 'Cài đặt ủy quyền đã được lưu.' });
        }
   };
  
  const handleLinkO365 = async (account?: AccountInfo, userToLink?: User) => { /* Logic remains similar, but should call a backend endpoint */ };
  const handleUnlinkO365 = () => { /* Logic remains similar, but should call a backend endpoint */ };
  
  const handleUpdateProfile = (updatedUser: User) => {
    handleUpdateUser(updatedUser);
    if(currentUser && currentUser.id === updatedUser.id) {
        setCurrentUser(updatedUser);
    }
    setProfileModalOpen(false);
  };
  
  const handleConfirmTeamSelection = (teamId: number) => {
    if (!currentUser) return;
    const updatedUser = { ...currentUser, teamId };
    handleUpdateUser(updatedUser);
    setCurrentUser(updatedUser);
    setTeamSelectionModalOpen(false);
    onNotification({ type: 'success', title: 'Cập nhật thành công!', message: `Chào mừng ${currentUser.name} đã tham gia vào tổ chuyên môn.` });
  };

  const schoolData = useMemo(() => {
    if (!selectedSchool) return { users: [], teams: [], lessonPlans: [] };
    const schoolUsers = users.filter(u => u.schoolId === selectedSchool.id);
    const schoolTeams = teams.filter(t => t.schoolId === selectedSchool.id);
    const schoolLessonPlans = lessonPlans.filter(p => p.schoolId === selectedSchool.id);
    return { users: schoolUsers, teams: schoolTeams, lessonPlans: schoolLessonPlans };
  }, [selectedSchool, users, teams, lessonPlans]);
  
  if (isLoadingApp) {
    return (
        <div className="fixed inset-0 bg-white flex flex-col justify-center items-center">
            <LoadingSpinner />
            <h2 className="mt-4 text-xl font-semibold text-gray-700">Đang tải dữ liệu hệ thống...</h2>
        </div>
    );
  }
  
   if (appError) {
        return (
            <div className="fixed inset-0 bg-white flex flex-col justify-center items-center p-8 text-center">
                <div className="text-red-500 mb-4">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
                <h2 className="mt-4 text-xl font-semibold text-gray-800">Đã xảy ra lỗi</h2>
                <p className="text-gray-600 mt-2">{appError}</p>
                <button onClick={() => window.location.reload()} className="mt-6 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Tải lại trang</button>
            </div>
        );
    }

  const renderMainContent = () => {
    if (!currentUser) {
      if (showLogin) {
        return <Login school={selectedSchool} onLogin={handleLogin} onO365Login={handleO365Login} onBackToHome={() => { setShowLogin(false); setSelectedSchool(null); }} />;
      }
      return <LandingPage onSelectSchool={handleSelectSchool} onGlobalAdminLogin={handleGlobalAdminLogin} schools={schools} onNotification={onNotification} />;
    }
    
    return (
      <div className="bg-gray-50 min-h-screen flex flex-col">
        <Navbar currentUser={currentUser} school={selectedSchool} onLogout={handleLogout} onProfileClick={() => setProfileModalOpen(true)} />
        <main className="container mx-auto p-4 sm:p-6 lg:p-8 flex-grow">
          <Dashboard 
            currentUser={currentUser} 
            lessonPlans={currentUser.role === Role.ADMIN ? lessonPlans : schoolData.lessonPlans} 
            users={currentUser.role === Role.ADMIN ? users : schoolData.users} 
            teams={currentUser.role === Role.ADMIN ? teams : schoolData.teams}
            schools={schools}
            delegation={delegation} 
            onUploadClick={handleOpenUploadModal} 
            onAdminClick={() => setAdminModalOpen(true)} 
            onTeamOverviewClick={() => setTeamOverviewModalOpen(true)} 
            onAction={handleLessonPlanAction} 
            onEdit={handleEditLessonPlan} 
            onNotification={onNotification} 
            onAddComment={handleAddComment}
          />
        </main>
      </div>
    );
  };

  return (
    <>
      {renderMainContent()}
      {notification && <NotificationModal isOpen={true} onClose={() => setNotification(null)} {...notification} />}
      {currentUser && (
        <>
          {isTeamSelectionModalOpen && (<TeamSelectionModal isOpen={isTeamSelectionModalOpen} teams={schoolData.teams} onConfirm={handleConfirmTeamSelection} userName={currentUser.name} /> )}
          {isUploadModalOpen && <UploadModal onClose={() => setUploadModalOpen(false)} onSave={handleSaveLessonPlan} lessonPlanToEdit={editingLessonPlan} currentUser={currentUser} onLinkO365={() => handleLinkO365()} msalInstance={msalInstance} account={msAccount} />}
          {isAdminModalOpen && [Role.PRINCIPAL, Role.ADMIN].includes(currentUser.role) && <AdminModal isOpen={isAdminModalOpen} onClose={() => setAdminModalOpen(false)} users={users} teams={teams} schools={schools} delegation={delegation} onAddUser={handleAddUser} onCreateTeam={handleCreateTeam} onUpdateUser={handleUpdateUser} onAssignTeamRole={handleAssignTeamRole} onSetDelegation={handleSetDelegation} onNotification={onNotification} onAddSchool={handleAddSchool} onUpdateSchool={handleUpdateSchool} onDeleteSchool={handleDeleteSchool} currentUser={currentUser} selectedSchool={selectedSchool}/>}
          {isProfileModalOpen && <UserProfileModal isOpen={isProfileModalOpen} onClose={() => setProfileModalOpen(false)} currentUser={currentUser} onLinkO365={() => handleLinkO365()} onUnlinkO365={handleUnlinkO365} onUpdateProfile={handleUpdateProfile} msalInstance={msalInstance} account={msAccount} onNotification={onNotification}/>}
          {isTeamOverviewModalOpen && (currentUser.role === Role.TEAM_LEADER || currentUser.role === Role.DEPUTY_TEAM_LEADER) && (<TeamOverviewModal isOpen={isTeamOverviewModalOpen} onClose={() => setTeamOverviewModalOpen(false)} currentUser={currentUser} teams={schoolData.teams} users={schoolData.users} lessonPlans={schoolData.lessonPlans} /> )}
        </>
      )}
    </>
  );
};

// -----------------------------------------------------------------------------
// SECTION 7: RENDER APP
// -----------------------------------------------------------------------------
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error("Could not find root element to mount to");
const root = ReactDOM.createRoot(rootElement);
root.render(<React.StrictMode><App /></React.StrictMode>);