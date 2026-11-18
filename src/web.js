'use strict';
// 라우트 공통 도구
const path = require('path');
const multer = require('multer');
const config = require('./config');
const storage = require('./storage');
const { AppError, randomId } = require('./util');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const needUser = (req, res, next) => (req.user ? next() : res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)));
const needSeller = (req, res, next) => (!req.user ? needUser(req, res, next) : req.user.seller ? next() : res.redirect('/my/seller'));
// 운영자 권한 + 추가 인증(TOTP)
const needStaff = (...roles) => (req, res, next) => {
  if (!req.user) return needUser(req, res, next);
  const st = req.user.staff;
  if (!st.length || !(st.includes('super') || roles.length === 0 || roles.some((r) => st.includes(r)))) return next(new AppError('찾을 수 없습니다.', 404));
  if (config.requireAdminMfa && !req.user.session.mfaOk) return res.redirect('/admin/mfa');
  next();
};

const upload = multer({
  storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, storage.tmpDir()), filename: (req, file, cb) => cb(null, 'up-' + randomId(12)) }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});
// multipart 폼: 파일 1개를 받아 검사·암호화 저장한 뒤 req.savedFile에 둔다.
const receiveFile = (purpose, { required = true } = {}) => [
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err) return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? `파일이 너무 큽니다(최대 ${Math.round(config.maxUploadBytes / 1048576)}MB).` : '업로드에 실패했습니다.', 413));
    next();
  }),
  h(async (req, res, next) => {
    if (!req.file) { if (required) throw new AppError('파일을 선택하세요.'); return next(); }
    // multer는 파일명을 latin1로 읽으므로 UTF-8로 되돌린다.
    const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    req.savedFile = await storage.saveFromPath(req.file.path, { originalName: path.basename(name), uploaderId: req.user.id, purpose });
    next();
  }),
];
module.exports = { h, needUser, needSeller, needStaff, receiveFile };
