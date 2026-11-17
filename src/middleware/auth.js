export function requireAuth(req, res, next) {
  if (!req.session?.user) {
    if (req.method === 'GET') {
      req.session.notice = { type: 'info', message: 'Silakan masuk untuk melanjutkan.' };
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).render('error', {
      title: 'Belum masuk',
      status: 401,
      message: 'Anda harus masuk terlebih dahulu.',
    });
  }
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) {
      if (req.method === 'GET') {
        req.session.notice = { type: 'info', message: 'Silakan masuk untuk melanjutkan.' };
        return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      }
      return res.status(401).render('error', {
        title: 'Belum masuk',
        status: 401,
        message: 'Anda harus masuk terlebih dahulu.',
      });
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', {
        title: 'Akses ditolak',
        status: 403,
        message: 'Peran akun Anda tidak memiliki izin membuka halaman ini.',
      });
    }
    next();
  };
}

/** Teknisi hanya bisa bekerja setelah kemitraan disetujui admin. */
export function requireApprovedTechnician(req, res, next) {
  if (!req.technician) {
    return res.status(403).render('error', {
      title: 'Profil teknisi tidak ditemukan',
      status: 403,
      message: 'Akun ini tidak memiliki profil teknisi.',
    });
  }
  if (req.technician.status !== 'approved') {
    req.session.notice = {
      type: 'info',
      message: 'Kemitraan Anda belum disetujui. Lengkapi pengajuan dan tunggu verifikasi admin.',
    };
    return res.redirect('/teknisi/pengajuan');
  }
  next();
}

export function redirectByRole(role) {
  if (role === 'admin') return '/admin';
  if (role === 'technician') return '/teknisi';
  return '/akun';
}

export function safeNext(target) {
  if (typeof target !== 'string') return null;
  if (!target.startsWith('/') || target.startsWith('//')) return null;
  if (target.startsWith('/login') || target.startsWith('/logout') || target.startsWith('/register')) return null;
  return target;
}
