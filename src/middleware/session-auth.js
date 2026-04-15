export function requireAuth(request, reply, done) {
  if (!request.session || !request.session.userId) {
    reply.code(401).send({ error: 'Not authenticated' });
    return;
  }
  done();
}

export function requireAdmin(request, reply, done) {
  if (!request.session || !request.session.userId) {
    reply.code(401).send({ error: 'Not authenticated' });
    return;
  }
  if (request.session.role !== 'admin') {
    reply.code(403).send({ error: 'Admin access required' });
    return;
  }
  done();
}
