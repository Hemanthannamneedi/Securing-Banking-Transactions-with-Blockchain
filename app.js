const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const nunjucks = require('nunjucks');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const port = 7000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) { fs.mkdirSync(uploadDir, { recursive: true }); }

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'public/uploads/') },
    filename: function (req, file, cb) { cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '-')) }
});
const upload = multer({ storage: storage });

nunjucks.configure(path.join(__dirname, 'templates'), { autoescape: true, express: app });

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/';
const client = new MongoClient(uri);
let db, usersCollection, transactionsCollection;

async function startServer() {
    try {
        await client.connect();
        db = client.db('securechain_bank');
        usersCollection = db.collection('users');
        transactionsCollection = db.collection('transactions');
        console.log("✅ Database Connected Successfully!");
        app.listen(port, () => console.log(`🚀 SecureChain running at http://127.0.0.1:${port}`));
    } catch (err) { console.error("❌ DB Connection Failed:", err); }
}

function generateIFSC(bankName) {
    const prefixes = { "SBI": "SBIN", "HDFC": "HDFC", "AXIS": "UTIB", "CANARA": "CNRB" };
    return (prefixes[bankName] || "BANK") + '0' + Math.floor(100000 + Math.random() * 900000);
}

class Block {
    constructor(index, timestamp, transaction_data, previous_hash) {
        this.index = index; this.timestamp = timestamp;
        this.transaction_data = transaction_data; this.previous_hash = previous_hash;
        this.hash = crypto.createHash('sha256').update(JSON.stringify(this)).digest('hex');
    }
}

class Blockchain {
    async addBlock(transactionData) {
        const lastDbBlock = await transactionsCollection.find().sort({ _id: -1 }).limit(1).toArray();
        const prevHash = lastDbBlock.length > 0 ? lastDbBlock[0].hash : "0";
        const newIndex = lastDbBlock.length > 0 ? lastDbBlock[0].index + 1 : 0;
        return new Block(newIndex, new Date().toISOString(), transactionData, prevHash);
    }
}
const bankBlockchain = new Blockchain();

async function enrichTx(txArray) {
    return await Promise.all(txArray.map(async tx => {
        let u = null;
        try { u = await usersCollection.findOne({ _id: new ObjectId(tx.transaction_data.user_id) }); } catch(e){}
        return { ...tx, sender_email: u ? u.email : 'Unknown User' };
    }));
}

// --- AUTH ROUTING ---
app.get('/', (req, res) => res.render('index.html'));
app.get('/login', (req, res) => res.render('login.html', { role: req.query.role || 'user' }));

app.post('/login', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'fingerprint', maxCount: 1 }, { name: 'signature', maxCount: 1 }]), async (req, res) => {
    const { action, email, password, role, first_name, last_name, mobile, bank, account_type, state, district, city } = req.body;
    
    if (action === 'register') {
        if (await usersCollection.findOne({ email })) return res.send(`<script>alert('Account already exists!'); window.location.href='/login?role=${role}';</script>`);
        
        const photoPath = req.files && req.files['photo'] ? '/uploads/' + req.files['photo'][0].filename : null;
        const fingerprintPath = req.files && req.files['fingerprint'] ? '/uploads/' + req.files['fingerprint'][0].filename : null;
        const signaturePath = req.files && req.files['signature'] ? '/uploads/' + req.files['signature'][0].filename : null;

        await usersCollection.insertOne({
            email, password, role, 
            first_name: first_name || "", last_name: last_name || "", mobile: mobile || "", address: "", 
            state: state || "", district: district || "", city: city || "",
            bank: role === 'user' ? bank || 'SBI' : null, 
            account_type: role === 'user' ? account_type || 'Savings Account' : null,
            branch_name: role === 'user' ? "Main Branch" : "Corporate Office", 
            branch_pincode: "", 
            ifsc_code: role === 'user' ? generateIFSC(bank || 'SBI') : null,
            account_number: null, 
            status: role === 'user' ? "pending_approval" : "active", 
            balance: 0.0, pin: null,
            photo: photoPath, fingerprint: fingerprintPath, signature: signaturePath,
            created_at: new Date().toISOString()
        });

        if (role === 'user') {
            return res.send("<script>alert('Registration & KYC Submitted! Please wait for Admin approval.'); window.location.href='/login?role=user';</script>");
        } else {
            return res.send(`<script>alert('Staff Registration Successful! You can now log in.'); window.location.href='/login?role=${role}';</script>`);
        }
    } else {
        const user = await usersCollection.findOne({ email, password, role });
        if (user) {
            if (role === 'user') {
                if (user.status === 'pending_approval') return res.send("<script>alert('Access Denied: Your account is still pending Admin approval.'); window.location.href='/login?role=user';</script>");
                return res.redirect(`/user/${user._id}`);
            }
            return res.redirect(`/${role}/${user._id}`);
        }
        res.send(`<script>alert('Invalid credentials!'); window.location.href='/login?role=${role}';</script>`);
    }
});

// --- UNIVERSAL STAFF PROFILE EDITOR ---
app.post('/staff/edit/:userId', async (req, res) => {
    const { first_name, last_name, mobile, address } = req.body;
    const user = await usersCollection.findOne({ _id: new ObjectId(req.params.userId) });
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { first_name, last_name, mobile, address } });
    res.redirect(`/${user.role}/${req.params.userId}`);
});

// --- ADMIN DASHBOARD ---
app.get('/admin/:userId', async (req, res) => {
    const user = await usersCollection.findOne({ _id: new ObjectId(req.params.userId) });
    const all_users = await usersCollection.find({ role: 'user' }).sort({ created_at: -1 }).toArray(); 
    const pending_users = await usersCollection.find({ status: "pending_approval" }).toArray();
    const deletion_requests = await usersCollection.find({ "deletion_request.status": "pending" }).toArray();
    const blocked_users = await usersCollection.find({ status: "locked" }).toArray();
    const branch_requests = await usersCollection.find({ "branch_request.status": "pending" }).toArray();
    
    let pending_transfers = await enrichTx(await transactionsCollection.find({ "transaction_data.status": "pending_auditor_approval" }).toArray());
    let pending_deposits = await enrichTx(await transactionsCollection.find({ "transaction_data.status": "pending_agent_approval" }).toArray());
    let history = await enrichTx(await transactionsCollection.find({ "transaction_data.status": { $in: ["approved", "rejected"] } }).sort({timestamp:-1}).toArray());

    const all_tx = await transactionsCollection.find().toArray();
    const fraud = all_tx.filter(tx => parseFloat(tx.transaction_data.amount) > 50000);
    const chartData = JSON.stringify(fraud.map(tx => tx.transaction_data.amount));
    const chartLabels = JSON.stringify(fraud.map(tx => `ID: ${tx.transaction_data.user_id.toString().slice(-6)}`));
    const risk = all_tx.filter(tx => parseFloat(tx.transaction_data.amount) > 20000 && parseFloat(tx.transaction_data.amount) <= 50000);
    const riskData = JSON.stringify(risk.map(tx => tx.transaction_data.amount));
    const riskLabels = JSON.stringify(risk.map(tx => `ID: ${tx.transaction_data.user_id.toString().slice(-6)}`));
    const recent = all_tx.slice(-15);
    const behaviorData = JSON.stringify(recent.map(tx => tx.transaction_data.amount));
    const behaviorLabels = JSON.stringify(recent.map(tx => tx.timestamp ? tx.timestamp.slice(11, 16) : '00:00'));

    res.render('admin.html', { user, all_users, pending_users, pending_transfers, pending_deposits, history, deletion_requests, blocked_users, branch_requests, chartData, chartLabels, riskData, riskLabels, behaviorData, behaviorLabels });
});
app.post('/admin/approve_transfer/:txId', async (req, res) => {
    const tx = await transactionsCollection.findOne({ _id: new ObjectId(req.params.txId) });
    await usersCollection.updateOne({ _id: new ObjectId(tx.transaction_data.user_id) }, { $inc: { balance: -tx.transaction_data.amount } });
    await usersCollection.updateOne({ account_number: tx.transaction_data.recipient_account }, { $inc: { balance: tx.transaction_data.amount } });
    await transactionsCollection.updateOne({ _id: new ObjectId(req.params.txId) }, { $set: { "transaction_data.status": "approved" } });
    res.redirect('back');
});
app.post('/admin/reject_transfer/:txId', async (req, res) => {
    await transactionsCollection.updateOne({ _id: new ObjectId(req.params.txId) }, { $set: { "transaction_data.status": "rejected" } });
    res.redirect('back');
});
app.post('/admin/approve_deposit/:txId', async (req, res) => {
    const tx = await transactionsCollection.findOne({ _id: new ObjectId(req.params.txId) });
    await usersCollection.updateOne({ _id: new ObjectId(tx.transaction_data.user_id) }, { $inc: { balance: tx.transaction_data.amount } });
    await transactionsCollection.updateOne({ _id: new ObjectId(req.params.txId) }, { $set: { "transaction_data.status": "approved" } });
    res.redirect('back');
});
app.post('/admin/reject_deposit/:txId', async (req, res) => {
    await transactionsCollection.updateOne({ _id: new ObjectId(req.params.txId) }, { $set: { "transaction_data.status": "rejected" } });
    res.redirect('back');
});
app.post('/admin/clear_history', async (req, res) => {
    await transactionsCollection.deleteMany({ "transaction_data.status": { $in: ["approved", "rejected"] } });
    res.redirect('back');
});
app.post('/admin/approve/:userId', async (req, res) => {
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { account_number: Math.floor(10000000000 + Math.random() * 90000000000).toString(), status: "active" } });
    res.redirect('back');
});
app.post('/admin/unlock/:userId', async (req, res) => {
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { status: "active" } });
    res.redirect('back');
});
app.post('/admin/approve_deletion/:userId', async (req, res) => {
    await usersCollection.deleteOne({ _id: new ObjectId(req.params.userId) });
    res.redirect('back');
});
app.post('/admin/deny_deletion/:userId', async (req, res) => {
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $unset: { deletion_request: "" } });
    res.redirect('back');
});
app.post('/admin/approve_branch/:userId', async (req, res) => {
    const userTarget = await usersCollection.findOne({ _id: new ObjectId(req.params.userId) });
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { branch_name: userTarget.branch_request.to_branch, branch_pincode: userTarget.branch_request.pincode, ifsc_code: generateIFSC(userTarget.bank) }, $unset: { branch_request: "" } });
    res.redirect('back');
});
app.post('/admin/deny_branch/:userId', async (req, res) => {
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $unset: { branch_request: "" } });
    res.redirect('back');
});

// --- AGENT DASHBOARD ---
app.get('/agent/:userId', async (req, res) => {
    const user = await usersCollection.findOne({ _id: new ObjectId(req.params.userId) });
    const all_users = await usersCollection.find({ role: 'user' }).sort({ created_at: -1 }).toArray(); 
    let pending_deposits = await enrichTx(await transactionsCollection.find({ "transaction_data.status": "pending_agent_approval" }).toArray());
    let history = await enrichTx(await transactionsCollection.find({ "transaction_data.type": "deposit", "transaction_data.status": { $in: ["approved", "rejected"] } }).sort({timestamp:-1}).toArray());
    const deletion_requests = await usersCollection.find({ "deletion_request.status": "pending" }).toArray();
    const blocked_users = await usersCollection.find({ status: "locked" }).toArray();
    const branch_requests = await usersCollection.find({ "branch_request.status": "pending" }).toArray();
    const all_tx = await transactionsCollection.find().toArray();
    const risk = all_tx.filter(tx => parseFloat(tx.transaction_data.amount) > 20000 && parseFloat(tx.transaction_data.amount) <= 50000);
    const riskData = JSON.stringify(risk.map(tx => tx.transaction_data.amount));
    const riskLabels = JSON.stringify(risk.map(tx => `ID: ${tx.transaction_data.user_id.toString().slice(-6)}`));
    res.render('agent.html', { user, all_users, pending_deposits, history, deletion_requests, blocked_users, branch_requests, riskData, riskLabels });
});
app.post('/agent/approve/:txId', async (req, res) => {
    const tx = await transactionsCollection.findOne({ _id: new ObjectId(req.params.txId) });
    await usersCollection.updateOne({ _id: new ObjectId(tx.transaction_data.user_id) }, { $inc: { balance: tx.transaction_data.amount } });
    await transactionsCollection.updateOne({ _id: new ObjectId(req.params.txId) }, { $set: { "transaction_data.status": "approved" } });
    res.redirect('back');
});
app.post('/agent/reject/:txId', async (req, res) => {
    await transactionsCollection.updateOne({ _id: new ObjectId(req.params.txId) }, { $set: { "transaction_data.status": "rejected" } });
    res.redirect('back');
});
app.post('/agent/clear_history', async (req, res) => {
    await transactionsCollection.deleteMany({ "transaction_data.type": "deposit", "transaction_data.status": { $in: ["approved", "rejected"] } });
    res.redirect('back');
});
app.post('/agent/unlock/:userId', async (req, res) => {
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { status: "active" } });
    res.redirect('back');
});

// --- AUDITOR DASHBOARD ---
app.get('/auditor/:userId', async (req, res) => {
    const user = await usersCollection.findOne({ _id: new ObjectId(req.params.userId) });
    const all_users = await usersCollection.find({ role: 'user' }).sort({ created_at: -1 }).toArray(); 
    let pending_transactions = await enrichTx(await transactionsCollection.find({ "transaction_data.status": "pending_auditor_approval" }).toArray());
    let history = await enrichTx(await transactionsCollection.find({ "transaction_data.type": "transfer", "transaction_data.status": { $in: ["approved", "rejected"] } }).sort({timestamp:-1}).toArray());
    const deletion_requests = await usersCollection.find({ "deletion_request.status": "pending" }).toArray();
    const blocked_users = await usersCollection.find({ status: "locked" }).toArray();
    const branch_requests = await usersCollection.find({ "branch_request.status": "pending" }).toArray();
    const all_tx = await transactionsCollection.find().toArray();
    const recent = all_tx.slice(-15);
    res.render('auditor.html', { user, all_users, pending_transactions, history, deletion_requests, blocked_users, branch_requests, behaviorData: JSON.stringify(recent.map(tx => tx.transaction_data.amount)), behaviorLabels: JSON.stringify(recent.map(tx => tx.timestamp ? tx.timestamp.slice(11, 16) : '00:00')) });
});
app.post('/auditor/approve/:txId', async (req, res) => {
    const tx = await transactionsCollection.findOne({ _id: new ObjectId(req.params.txId) });
    await usersCollection.updateOne({ _id: new ObjectId(tx.transaction_data.user_id) }, { $inc: { balance: -tx.transaction_data.amount } });
    await usersCollection.updateOne({ account_number: tx.transaction_data.recipient_account }, { $inc: { balance: tx.transaction_data.amount } });
    await transactionsCollection.updateOne({ _id: new ObjectId(req.params.txId) }, { $set: { "transaction_data.status": "approved" } });
    res.redirect('back');
});
app.post('/auditor/reject/:txId', async (req, res) => {
    await transactionsCollection.updateOne({ _id: new ObjectId(req.params.txId) }, { $set: { "transaction_data.status": "rejected" } });
    res.redirect('back');
});
app.post('/auditor/clear_history', async (req, res) => {
    await transactionsCollection.deleteMany({ "transaction_data.type": "transfer", "transaction_data.status": { $in: ["approved", "rejected"] } });
    res.redirect('back');
});
app.post('/auditor/unlock/:userId', async (req, res) => {
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { status: "active" } });
    res.redirect('back');
});

// --- USER DASHBOARD & BALANCE PIN LOGIC ---
app.get('/user/:userId', async (req, res) => {
    const user = await usersCollection.findOne({ _id: new ObjectId(req.params.userId) });
    if (!user) return res.send("Account has been permanently deleted.");
    const transactions = await transactionsCollection.find({ $or: [{ "transaction_data.user_id": req.params.userId }, { "transaction_data.recipient_account": user.account_number }] }).sort({ timestamp: -1 }).toArray();
    const show_balance = req.query.reveal === 'true';
    const pin_error = req.query.error;
    res.render('user.html', { user, transactions, show_balance, pin_error });
});

// ✅ THIS IS THE ROUTE THAT WAS MISSING CAUSING THE "Cannot POST /user/set_pin/" ERROR
app.post('/user/set_pin/:userId', async (req, res) => {
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { pin: req.body.pin } });
    res.redirect(`/user/${req.params.userId}?reveal=true`);
});

app.post('/user/verify_pin/:userId', async (req, res) => {
    const user = await usersCollection.findOne({ _id: new ObjectId(req.params.userId) });
    if (user.pin === req.body.pin) res.redirect(`/user/${req.params.userId}?reveal=true`);
    else res.redirect(`/user/${req.params.userId}?error=Incorrect PIN`);
});

app.post('/user/edit/:userId', async (req, res) => {
    const { first_name, last_name, mobile, address } = req.body;
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { first_name, last_name, mobile, address } });
    res.redirect(`/user/${req.params.userId}`);
});
app.post('/user/transfer/:userId', async (req, res) => {
    const amountFloat = parseFloat(req.body.amount);
    const sender = await usersCollection.findOne({ _id: new ObjectId(req.params.userId) });
    if (sender.balance < amountFloat) return res.send("Error: Insufficient funds.");

    let txStatus = amountFloat > 100000 ? "flagged_fraud" : "pending_auditor_approval";
    if (amountFloat > 100000) await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { status: "locked" } });
    
    await transactionsCollection.insertOne(await bankBlockchain.addBlock({ user_id: req.params.userId, sender_account: sender.account_number, recipient_account: req.body.recipient_account, amount: amountFloat, type: "transfer", status: txStatus }));
    res.redirect(`/user/${req.params.userId}`);
});
app.post('/user/deposit/:userId', async (req, res) => {
    const amountFloat = parseFloat(req.body.deposit_amount);
    let txStatus = amountFloat > 50000 ? "flagged_fraud" : "pending_agent_approval";
    if (amountFloat > 50000) await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { status: "locked" } });
    
    await transactionsCollection.insertOne(await bankBlockchain.addBlock({ user_id: req.params.userId, amount: amountFloat, type: "deposit", status: txStatus }));
    res.redirect(`/user/${req.params.userId}`);
});
app.post('/user/request_deletion/:userId', async (req, res) => {
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { deletion_request: { reason: req.body.reason, status: "pending" } } });
    res.redirect(`/user/${req.params.userId}`);
});
app.post('/user/request_branch/:userId', async (req, res) => {
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { branch_request: { to_branch: req.body.to_branch_city, pincode: req.body.to_branch_pincode, status: "pending" } } });
    res.redirect(`/user/${req.params.userId}`);
});
app.post('/user/clear_history/:userId', async (req, res) => {
    const user = await usersCollection.findOne({ _id: new ObjectId(req.params.userId) });
    await transactionsCollection.deleteMany({ $or: [{ "transaction_data.user_id": req.params.userId }, { "transaction_data.recipient_account": user.account_number }] });
    res.redirect(`/user/${req.params.userId}`);
});

startServer();