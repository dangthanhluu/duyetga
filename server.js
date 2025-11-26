// -----------------------------------------------------------------------------
// SECTION 1: IMPORTS & SETUP
// -----------------------------------------------------------------------------
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

// Config for __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- File Upload Setup (Multer) ---
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = path.join(__dirname, 'uploads');
    try {
        await fs.mkdir(uploadPath, { recursive: true });
    } catch (e) {
        // Ignore error if directory exists
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    // Use latin1 to utf8 conversion for proper handling of special characters in filenames if needed
    cb(null, `${Date.now()}-${Buffer.from(file.originalname, 'latin1').toString('utf8')}`);
  }
});
const upload = multer({ storage });

// -----------------------------------------------------------------------------
// SECTION 2: DATABASE LOGIC (db.json persistence)
// -----------------------------------------------------------------------------
const DB_PATH = path.join(__dirname, 'db.json');
let db; // In-memory cache of the database

const MOCK_USERS_DATA = [
    { id: 1, name: 'Quản trị viên Toàn Cầu', role: 'Quản trị viên toàn cầu', email: 'admin@gmail.com', password: 'Luuktm09@21', schoolId: undefined },
    { id: 2, name: 'Nguyễn Văn An', role: 'Hiệu trưởng', email: 'hieutruong@qni.edu.vn', password: '123', schoolId: 'THCS-BINHSON' },
    { id: 3, name: 'Trần Thị Bích', role: 'Phó Hiệu trưởng', email: 'phohieutruong@qni.edu.vn', o365Email: 'bicht@qni.edu.vn', schoolId: 'THCS-BINHSON' },
    { id: 4, name: 'Lê Minh Cường', role: 'Tổ trưởng Chuyên môn', email: 'cuonglm@qni.edu.vn', o365Email: 'cuonglm@qni.edu.vn', teamId: 1, schoolId: 'THCS-BINHSON' },
    { id: 5, name: 'Phạm Thị Dung', role: 'Tổ phó Chuyên môn', email: 'dungpt@qni.edu.vn', o365Email: 'dungpt@qni.edu.vn', teamId: 1, schoolId: 'THCS-BINHSON' },
    { id: 6, name: 'Hoàng Văn Em', role: 'Giáo viên', email: 'emhv@qni.edu.vn', o365Email: 'emhv@qni.edu.vn', teamId: 1, schoolId: 'THCS-BINHSON' },
    { id: 7, name: 'Vũ Thị Gấm', role: 'Giáo viên', email: 'gamvt@qni.edu.vn', o365Email: 'gamvt@qni.edu.vn', teamId: 1, schoolId: 'THCS-BINHSON' },
    { id: 8, name: 'Đỗ Hùng Kiên', role: 'Tổ trưởng Chuyên môn', email: 'kiendh@qni.edu.vn', o365Email: 'kiendh@qni.edu.vn', teamId: 2, schoolId: 'THCS-BINHSON' },
    { id: 9, name: 'Nguyễn Thị Lan', role: 'Giáo viên', email: 'lann@qni.edu.vn', o365Email: 'lann@qni.edu.vn', teamId: 2, schoolId: 'THCS-BINHSON' },
    { id: 10, name: 'Phan Huy Ích', role: 'Hiệu trưởng', email: 'hieutruong.st@qni.edu.vn', password: '123', schoolId: 'THPT-SONTINH' },
    { id: 11, name: 'Trần Văn Mười', role: 'Tổ trưởng Chuyên môn', email: 'muoitv.st@qni.edu.vn', teamId: 3, schoolId: 'THPT-SONTINH' },
    { id: 12, name: 'Lý Thị Na', role: 'Giáo viên', email: 'nalt.st@qni.edu.vn', teamId: 3, schoolId: 'THPT-SONTINH' },
];

const now = new Date();

const MOCK_DATA = {
    schools: [
        { id: 'THCS-BINHSON', name: 'Trường THCS Bình Sơn' },
        { id: 'THPT-SONTINH', name: 'Trường THPT Sơn Tịnh' },
    ],
    users: MOCK_USERS_DATA,
    teams: [
        { id: 1, name: 'Tổ Khoa học Tự nhiên', leaderId: 4, deputyLeaderId: 5, schoolId: 'THCS-BINHSON' },
        { id: 2, name: 'Tổ Khoa học Xã hội', leaderId: 8, schoolId: 'THCS-BINHSON' },
        { id: 3, name: 'Tổ Toán - Tin', leaderId: 11, schoolId: 'THPT-SONTINH' },
    ],
    lessonPlans: [
        { id: 1, title: 'Bài dạy: Phản ứng Oxi hóa - Khử', submittedBy: MOCK_USERS_DATA[5], submittedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(), status: 'Chờ Tổ trưởng duyệt', teamId: 1, subject: 'Khoa học tự nhiên', grade: 'Khối 8', class: '8A', file: { name: 'KHTN8_Oxihoa.pdf', url: '/uploads/mock-file.pdf' }, history: [ { action: 'Nộp Kế hoạch bài dạy', user: MOCK_USERS_DATA[5], timestamp: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString() }], schoolId: 'THCS-BINHSON', comments: [] },
        { id: 2, title: 'Bài dạy: Truyện Kiều - Nguyễn Du', submittedBy: MOCK_USERS_DATA[8], submittedAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(), status: 'Tổ trưởng từ chối', teamId: 2, subject: 'Ngữ văn', grade: 'Khối 9', class: '9A', file: { name: 'NguVan9_TruyenKieu.pdf', url: '/uploads/mock-file.pdf' }, history: [ { action: 'Nộp Kế hoạch bài dạy', user: MOCK_USERS_DATA[8], timestamp: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString() }, { action: 'Tổ trưởng từ chối', user: MOCK_USERS_DATA[7], timestamp: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString(), reason: 'Cần bổ sung phần câu hỏi thảo luận.' }], comments: [{id: 1, user: MOCK_USERS_DATA[7], timestamp: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000), text: 'Em xem lại mục tiêu bài học và bổ sung thêm các câu hỏi thảo luận nhóm để tăng tương tác nhé.'}, {id: 2, user: MOCK_USERS_DATA[8], timestamp: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), text: 'Dạ, em đã nhận được góp ý ạ. Em sẽ chỉnh sửa ngay.'}], schoolId: 'THCS-BINHSON' },
        { id: 3, title: 'Bài dạy: Thì Hiện tại Hoàn thành', submittedBy: MOCK_USERS_DATA[6], submittedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(), status: 'Chờ Hiệu trưởng duyệt', teamId: 1, subject: 'Ngoại ngữ 1 (Tiếng Anh)', grade: 'Khối 7', class: '7B', file: { name: 'English7_PresentPerfect.pdf', url: '/uploads/mock-file.pdf' }, history: [ { action: 'Nộp Kế hoạch bài dạy', user: MOCK_USERS_DATA[6], timestamp: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString() }, { action: 'Tổ trưởng đã duyệt', user: MOCK_USERS_DATA[3], timestamp: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString() }], schoolId: 'THCS-BINHSON', comments: [] },
        { id: 4, title: 'Bài dạy: Lịch sử Việt Nam giai đoạn 1945-1954', submittedBy: MOCK_USERS_DATA[8], submittedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(), status: 'Đã ban hành', teamId: 2, subject: 'Lịch sử và Địa lí', grade: 'Khối 9', class: '9B', file: { name: 'LichSu9_1945.pdf', url: '/uploads/mock-file.pdf' }, finalApprover: MOCK_USERS_DATA[1], finalApprovedAt: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString(), history: [ { action: 'Nộp Kế hoạch bài dạy', user: MOCK_USERS_DATA[8], timestamp: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString() }, { action: 'Tổ trưởng đã duyệt', user: MOCK_USERS_DATA[7], timestamp: new Date(now.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString() }, { action: 'Hiệu trưởng đã duyệt', user: MOCK_USERS_DATA[1], timestamp: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString() }, { action: 'Đã ban hành', user: MOCK_USERS_DATA[1], timestamp: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString() } ], schoolId: 'THCS-BINHSON', comments: [] },
        { id: 5, title: 'Soạn bài: Lập trình Scratch cơ bản', submittedBy: MOCK_USERS_DATA[6], submittedAt: new Date().toISOString(), status: 'Bản nháp', teamId: 1, subject: 'Tin học', grade: 'Khối 6', class: '6A', file: { name: 'TinHoc6_Scratch.pdf', url: '/uploads/mock-file.pdf' }, history: [{ action: 'Tạo bản nháp', user: MOCK_USERS_DATA[6], timestamp: new Date().toISOString() }], schoolId: 'THCS-BINHSON', comments: [] },
        { id: 6, title: 'Bài dạy: Giới hạn hàm số', submittedBy: MOCK_USERS_DATA[11], submittedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(), status: 'Chờ Tổ trưởng duyệt', teamId: 3, subject: 'Toán', grade: 'Khối 11', class: '11A1', file: { name: 'Toan11_GioiHan.pdf', url: '/uploads/mock-file.pdf' }, history: [ { action: 'Nộp Kế hoạch bài dạy', user: MOCK_USERS_DATA[11], timestamp: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString() }], schoolId: 'THPT-SONTINH', comments: [] },
    ],
    delegation: { principalToVp: false, teamDelegation: { 1: false, 2: false, 3: false } }
};

const readDb = async () => {
    try {
        const data = await fs.readFile(DB_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('db.json not found. Creating a new one with mock data.');
            await fs.writeFile(DB_PATH, JSON.stringify(MOCK_DATA, null, 2));
            return MOCK_DATA;
        }
        throw error;
    }
};

const writeDb = async () => {
    await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
};

// -----------------------------------------------------------------------------
// SECTION 3: API ENDPOINTS
// -----------------------------------------------------------------------------

// --- Bootstrap ---
app.get('/api/bootstrap', async (req, res) => {
    if (!db) {
        try {
            db = await readDb();
        } catch (error) {
            console.error("Error lazy loading db:", error);
            return res.status(500).json({ error: "Database not available" });
        }
    }
    res.json(db);
});

// --- Lesson Plans ---
app.post('/api/lesson-plans', upload.single('file'), async (req, res) => {
    const { details, isDraft } = req.body;
    const planDetails = JSON.parse(details);
    
    if (!req.file) {
        return res.status(400).json({ message: "File is required." });
    }

    const submitter = db.users.find(u => u.id === 6); // Mock submitter (Hoàng Văn Em)

    if (!submitter) {
         return res.status(404).json({ message: "Submitter user not found." });
    }

    const newPlan = {
        id: Date.now(),
        ...planDetails,
        submittedBy: submitter,
        teamId: submitter.teamId,
        submittedAt: new Date().toISOString(),
        status: isDraft === 'true' ? 'Bản nháp' : 'Chờ Tổ trưởng duyệt',
        file: {
            name: req.file.originalname,
            url: `/uploads/${req.file.filename}`,
            content: null,
            isExternalLink: false,
        },
        history: [{
            action: isDraft === 'true' ? 'Tạo bản nháp' : 'Nộp Kế hoạch bài dạy',
            user: submitter,
            timestamp: new Date().toISOString()
        }],
        comments: []
    };
    db.lessonPlans.push(newPlan);
    await writeDb();
    res.status(201).json(newPlan);
});

app.put('/api/lesson-plans/:id', upload.single('file'), async (req, res) => {
    const { id } = req.params;
    const { details, isDraft } = req.body;
    const planDetails = JSON.parse(details);
    
    const planIndex = db.lessonPlans.findIndex(p => p.id == id);
    if (planIndex === -1) {
        return res.status(404).json({ message: "Lesson plan not found" });
    }

    const plan = db.lessonPlans[planIndex];
    const updater = db.users.find(u => u.id === plan.submittedBy.id);

    if(!updater) {
        return res.status(404).json({ message: "Updater user not found" });
    }

    // Update details
    Object.assign(plan, planDetails);
    
    // Update file if a new one is uploaded
    if (req.file) {
        plan.file = {
            name: req.file.originalname,
            url: `/uploads/${req.file.filename}`,
        };
    }
    
    // Update status and history
    const oldStatus = plan.status;
    const newStatus = isDraft === 'true' ? 'Bản nháp' : 'Chờ Tổ trưởng duyệt';
    if(oldStatus !== newStatus || req.file) {
        plan.status = newStatus;
        plan.submittedAt = new Date().toISOString();
        const action = oldStatus === 'Bản nháp' ? 'Nộp Kế hoạch bài dạy' : 'Nộp lại Kế hoạch bài dạy';
        plan.history.push({
            action: action,
            user: updater,
            timestamp: new Date().toISOString()
        });
    }

    db.lessonPlans[planIndex] = plan;
    await writeDb();
    res.json(plan);
});


app.put('/api/lesson-plans/:id/status', async (req, res) => {
    const { id } = req.params;
    const { newStatus, reason } = req.body;
    
    // In a real app, you'd get the user from the auth token
    const currentUser = db.users.find(u => u.id === 4); // Mock: Lê Minh Cường (Tổ trưởng)

    const planIndex = db.lessonPlans.findIndex(p => p.id == id);
    if (planIndex === -1) {
        return res.status(404).json({ message: "Lesson plan not found" });
    }

    const plan = db.lessonPlans[planIndex];
    plan.status = newStatus;
    
    let action = 'Cập nhật trạng thái';
    switch (newStatus) {
      case 'Chờ Tổ trưởng duyệt': action = 'Nộp lại Kế hoạch bài dạy'; break;
      case 'Tổ trưởng từ chối': action = 'Tổ trưởng từ chối'; break;
      case 'Chờ Hiệu trưởng duyệt': action = 'Tổ trưởng đã duyệt'; break;
      case 'Đã phê duyệt': action = 'Hiệu trưởng đã duyệt'; break;
      case 'Hiệu trưởng từ chối': action = 'Hiệu trưởng từ chối'; break;
      case 'Đã ban hành': action = 'Đã ban hành'; plan.finalApprover = currentUser; plan.finalApprovedAt = new Date().toISOString(); break;
      case 'Bản nháp': action = 'Thu hồi để chỉnh sửa'; break;
    }

    plan.history.push({
        action,
        user: currentUser,
        timestamp: new Date().toISOString(),
        ...(reason && { reason })
    });
    
    db.lessonPlans[planIndex] = plan;
    await writeDb();
    res.json(plan);
});

app.post('/api/lesson-plans/:id/comments', async (req, res) => {
    const { id } = req.params;
    const { text } = req.body;

    // In a real app, you'd get the user from an auth token
    const currentUser = db.users.find(u => u.id === 4); // Mock: Lê Minh Cường (Tổ trưởng)

    if (!currentUser) {
        return res.status(401).json({ message: "Unauthorized" });
    }
    if (!text || typeof text !== 'string' || text.trim() === '') {
        return res.status(400).json({ message: "Comment text cannot be empty" });
    }

    const planIndex = db.lessonPlans.findIndex(p => p.id == id);
    if (planIndex === -1) {
        return res.status(404).json({ message: "Lesson plan not found" });
    }

    const plan = db.lessonPlans[planIndex];
    const newComment = {
        id: Date.now(),
        user: currentUser,
        timestamp: new Date().toISOString(),
        text: text.trim(),
    };
    
    if (!plan.comments) {
        plan.comments = [];
    }
    plan.comments.push(newComment);
    
    db.lessonPlans[planIndex] = plan;
    await writeDb();
    res.json(plan);
});

// --- Users ---
app.post('/api/users', async (req, res) => {
    const newUserDetails = req.body;
    const newUser = {
        id: Date.now(),
        ...newUserDetails,
        role: newUserDetails.role || 'Giáo viên',
    };
    db.users.push(newUser);
    await writeDb();
    res.status(201).json(newUser);
});

app.put('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    const updatedDetails = req.body;
    const userIndex = db.users.findIndex(u => u.id == id);
    if (userIndex === -1) {
        return res.status(404).json({ message: "User not found" });
    }
    db.users[userIndex] = { ...db.users[userIndex], ...updatedDetails };
    await writeDb();
    res.json(db.users[userIndex]);
});

// --- Teams ---
app.post('/api/teams', async (req, res) => {
    const { name, schoolId } = req.body;
    const newTeam = {
        id: Date.now(),
        name,
        schoolId,
    };
    db.teams.push(newTeam);
    await writeDb();
    res.status(201).json(newTeam);
});

app.post('/api/teams/:id/assign-role', async (req, res) => {
    const { id } = req.params;
    const { roleType, userId } = req.body; // roleType: 'leader' or 'deputy'

    const teamIndex = db.teams.findIndex(t => t.id == id);
    if (teamIndex === -1) {
        return res.status(404).json({ message: "Team not found" });
    }

    const team = db.teams[teamIndex];
    const userToDemoteId = roleType === 'leader' ? team.leaderId : team.deputyLeaderId;

    // Assign new role
    if (roleType === 'leader') {
        team.leaderId = userId || undefined;
    } else {
        team.deputyLeaderId = userId || undefined;
    }

    const updatedUsers = [];

    // Demote old leader/deputy if they are not the new one
    if (userToDemoteId && userToDemoteId !== userId) {
        const oldLeaderIndex = db.users.findIndex(u => u.id === userToDemoteId);
        if (oldLeaderIndex !== -1) {
            db.users[oldLeaderIndex].role = 'Giáo viên';
            updatedUsers.push(db.users[oldLeaderIndex]);
        }
    }

    // Promote new leader/deputy
    if (userId) {
        const newLeaderIndex = db.users.findIndex(u => u.id === userId);
        if (newLeaderIndex !== -1) {
            db.users[newLeaderIndex].role = roleType === 'leader' ? 'Tổ trưởng Chuyên môn' : 'Tổ phó Chuyên môn';
            updatedUsers.push(db.users[newLeaderIndex]);
        }
    }
    
    db.teams[teamIndex] = team;
    await writeDb();
    res.json({ updatedTeam: team, updatedUsers });
});


// --- Schools ---
app.post('/api/schools', async (req, res) => {
    const { name } = req.body;
    const slugify = (text) => text.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/--+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
    const newSchool = {
        id: slugify(name).toUpperCase() + '-' + Date.now().toString().slice(-4),
        name,
    };
    db.schools.push(newSchool);
    await writeDb();
    res.status(201).json(newSchool);
});

app.put('/api/schools/:id', async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    const schoolIndex = db.schools.findIndex(s => s.id === id);
    if (schoolIndex === -1) {
        return res.status(404).json({ message: "School not found" });
    }
    db.schools[schoolIndex].name = name;
    await writeDb();
    res.json(db.schools[schoolIndex]);
});

app.delete('/api/schools/:id', async (req, res) => {
    const { id } = req.params;
    db.schools = db.schools.filter(s => s.id !== id);
    db.teams = db.teams.filter(t => t.schoolId !== id);
    db.users = db.users.filter(u => u.schoolId !== id);
    db.lessonPlans = db.lessonPlans.filter(p => p.schoolId !== id);
    await writeDb();
    res.status(204).send();
});


// --- Delegation ---
app.put('/api/delegation', async (req, res) => {
    const newDelegation = req.body;
    db.delegation = newDelegation;
    await writeDb();
    res.json(db.delegation);
});


// -----------------------------------------------------------------------------
// SECTION 4: START SERVER
// -----------------------------------------------------------------------------
const startServer = async () => {
  try {
    db = await readDb();
    app.listen(PORT, () => {
      console.log(`Backend server is running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to load DB or start server:', err);
  }
};

startServer();
