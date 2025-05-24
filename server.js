const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// Lưu trữ thông tin phòng
const rooms = new Map();

// Generate room ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// API tạo phòng mới
app.post("/api/create-room", (req, res) => {
  const roomId = generateRoomId();
  rooms.set(roomId, {
    id: roomId,
    users: [],
    createdAt: new Date(),
  });

  res.json({ roomId });
});

// API kiểm tra phòng có tồn tại
app.get("/api/room/:roomId", (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (room) {
    res.json({ exists: true, userCount: room.users.length });
  } else {
    res.json({ exists: false });
  }
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Join room
  socket.on("join-room", (data) => {
    const { roomId, userName } = data;

    if (!rooms.has(roomId)) {
      socket.emit("error", "Room not found");
      return;
    }

    const room = rooms.get(roomId);
    const user = {
      id: socket.id,
      name: userName || `User${room.users.length + 1}`,
    };

    room.users.push(user);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = user.name;

    // Gửi danh sách user hiện tại cho user mới
    socket.emit(
      "existing-users",
      room.users.filter((u) => u.id !== socket.id)
    );

    // Thông báo cho các user khác về user mới
    socket.to(roomId).emit("user-joined", user);

    console.log(
      `${user.name} joined room ${roomId}. Total users: ${room.users.length}`
    );
  });

  // WebRTC signaling - nhận offer và forward đến target
  socket.on("offer", (data) => {
    console.log(`Offer from ${socket.id} to ${data.target}`);
    socket.to(data.target).emit("offer", {
      offer: data.offer,
      caller: socket.id,
    });
  });

  // WebRTC signaling - nhận answer và forward đến target
  socket.on("answer", (data) => {
    console.log(`Answer from ${socket.id} to ${data.target}`);
    socket.to(data.target).emit("answer", {
      answer: data.answer,
      answerer: socket.id,
    });
  });

  // WebRTC signaling - nhận ice candidate và forward
  socket.on("ice-candidate", (data) => {
    socket.to(data.target).emit("ice-candidate", {
      candidate: data.candidate,
      sender: socket.id,
    });
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.users = room.users.filter((user) => user.id !== socket.id);
        socket.to(socket.roomId).emit("user-left", socket.id);

        console.log(
          `${socket.userName} left room ${socket.roomId}. Remaining: ${room.users.length}`
        );

        // Xóa phòng nếu không còn ai
        if (room.users.length === 0) {
          rooms.delete(socket.roomId);
          console.log(`Room ${socket.roomId} deleted`);
        }
      }
    }
    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
