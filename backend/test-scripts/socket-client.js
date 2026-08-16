const io = require('socket.io-client');
const url = 'http://localhost:3000';
const sessionId = process.argv[2];
const dishId = process.argv[3];
const qty = parseInt(process.argv[4] || '1');

if (!sessionId || !dishId) {
  console.error('Usage: node socket-client.js <sessionId> <dishId> <qty>');
  process.exit(1);
}

const socket = io(url, { transports: ['websocket'] });

socket.on('connect', () => {
  console.log('connected', socket.id);
  socket.emit('cart:join', { sessionId });
  // wait for join response then add
  setTimeout(() => {
    console.log('adding', qty, 'of', dishId, 'to session', sessionId);
    socket.emit('cart:add', { sessionId, dishId, quantity: qty });
  }, 300);
});

socket.on('cart:synced', (cart) => {
  console.log('cart:synced for session', sessionId, JSON.stringify(cart, null, 2));
});

socket.on('session:merged_or_moved', (payload) => {
  console.log('session:merged_or_moved', JSON.stringify(payload, null, 2));
});

socket.on('session:moved', (payload) => {
  console.log('session:moved', JSON.stringify(payload, null, 2));
});

socket.on('cart:error', (err) => console.error('cart:error', err));

setTimeout(() => {
  console.log('closing socket');
  socket.close();
}, 8000);
