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
  pingTimeout: 60000,
  pingInterval: 25000,
  // Thêm cấu hình để hỗ trợ kết nối qua các mạng khác nhau
  transports: ["websocket", "polling"],
  allowEIO3: true,
});

app.use(cors());
app.use(express.json());

// Serve static files if needed
app.use(express.static("public"));

// Lưu trữ thông tin phòng với thêm metadata
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
    // Thêm thống kê kết nối
    connectionAttempts: 0,
    successfulConnections: 0,
  });

  console.log(`Room created: ${roomId}`);
  res.json({ roomId });
});

// API kiểm tra phòng có tồn tại
app.get("/api/room/:roomId", (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (room) {
    res.json({
      exists: true,
      userCount: room.users.length,
      users: room.users.map((u) => ({ id: u.id, name: u.name })),
    });
  } else {
    res.json({ exists: false });
  }
});

// API để lấy thông tin debug
app.get("/api/debug/rooms", (req, res) => {
  const roomsInfo = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    userCount: room.users.length,
    users: room.users.map((u) => ({ name: u.name, joinedAt: u.joinedAt })),
    createdAt: room.createdAt,
    connectionAttempts: room.connectionAttempts,
    successfulConnections: room.successfulConnections,
  }));

  res.json({ rooms: roomsInfo, totalRooms: rooms.size });
});

// Clean up empty rooms periodically
setInterval(() => {
  rooms.forEach((room, roomId) => {
    if (room.users.length === 0) {
      const timeSinceCreation = Date.now() - new Date(room.createdAt).getTime();
      // Delete empty rooms older than 1 hour
      if (timeSinceCreation > 3600000) {
        rooms.delete(roomId);
        console.log(`Cleaned up empty room: ${roomId}`);
      }
    }
  });
}, 300000); // Check every 5 minutes

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id} from ${socket.handshake.address}`);

  // Join room
  socket.on("join-room", (data) => {
    const { roomId, userName } = data;

    if (!rooms.has(roomId)) {
      socket.emit("error", "Room not found");
      return;
    }

    const room = rooms.get(roomId);

    // Kiểm tra xem user đã tồn tại chưa (reconnection)
    const existingUserIndex = room.users.findIndex((u) => u.id === socket.id);
    if (existingUserIndex !== -1) {
      room.users[existingUserIndex].name =
        userName || room.users[existingUserIndex].name;
      console.log(`User ${socket.id} reconnected to room ${roomId}`);
    } else {
      const user = {
        id: socket.id,
        name: userName || `User${room.users.length + 1}`,
        joinedAt: new Date(),
        // Thêm thông tin kết nối
        address: socket.handshake.address,
        userAgent: socket.handshake.headers["user-agent"],
      };

      room.users.push(user);
      room.connectionAttempts++;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = room.users.find((u) => u.id === socket.id)?.name;

    console.log(
      `${socket.userName} (${socket.id}) joined room ${roomId}. Total users: ${room.users.length}`
    );

    // Gửi thông tin phòng cho user mới
    socket.emit("room-joined", {
      roomId,
      users: room.users
        .filter((u) => u.id !== socket.id)
        .map((u) => ({ id: u.id, name: u.name })),
    });

    // Thông báo cho các user khác về user mới
    socket.to(roomId).emit("user-joined", {
      id: socket.id,
      name: socket.userName,
    });
  });

  // Thêm event để track connection status
  socket.on("connection-status", (data) => {
    const { roomId, status, targetUserId } = data;
    console.log(
      `Connection status in room ${roomId}: ${status} between ${socket.id} and ${targetUserId}`
    );

    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (status === "connected") {
        room.successfulConnections++;
      }
    }
  });

  // Leave room explicitly
  socket.on("leave-room", (roomId) => {
    if (socket.roomId === roomId) {
      handleUserLeave(socket);
    }
  });

  // WebRTC signaling với enhanced logging
  socket.on("offer", (data) => {
    const logMsg = `Offer: ${socket.id} -> ${data.target} in room ${socket.roomId}`;
    console.log(logMsg);

    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      const targetUser = room?.users.find((u) => u.id === data.target);

      if (targetUser) {
        socket.to(data.target).emit("offer", {
          offer: data.offer,
          caller: socket.id,
        });
      } else {
        console.log(
          `❌ Target user ${data.target} not found in room ${socket.roomId}`
        );
        socket.emit("error", `Target user not found: ${data.target}`);
      }
    }
  });

  socket.on("answer", (data) => {
    const logMsg = `Answer: ${socket.id} -> ${data.target} in room ${socket.roomId}`;
    console.log(logMsg);

    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      const targetUser = room?.users.find((u) => u.id === data.target);

      if (targetUser) {
        socket.to(data.target).emit("answer", {
          answer: data.answer,
          answerer: socket.id,
        });
      } else {
        console.log(
          `❌ Target user ${data.target} not found in room ${socket.roomId}`
        );
        socket.emit("error", `Target user not found: ${data.target}`);
      }
    }
  });

  socket.on("ice-candidate", (data) => {
    const candidateType = data.candidate?.type || "unknown";
    console.log(
      `ICE candidate (${candidateType}): ${socket.id} -> ${data.target}`
    );

    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      const targetUser = room?.users.find((u) => u.id === data.target);

      if (targetUser) {
        socket.to(data.target).emit("ice-candidate", {
          candidate: data.candidate,
          sender: socket.id,
        });
      } else {
        console.log(
          `❌ Target user ${data.target} not found for ICE candidate`
        );
      }
    }
  });

  // Handle user disconnect
  socket.on("disconnect", (reason) => {
    console.log(`User ${socket.id} disconnected: ${reason}`);
    handleUserLeave(socket);
  });

  // Helper function to handle user leaving
  function handleUserLeave(socket) {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        // Remove user from room
        const userIndex = room.users.findIndex((user) => user.id === socket.id);
        if (userIndex !== -1) {
          room.users.splice(userIndex, 1);

          // Notify other users
          socket.to(socket.roomId).emit("user-left", socket.id);

          console.log(
            `${socket.userName || socket.id} left room ${
              socket.roomId
            }. Remaining: ${room.users.length}`
          );

          // Delete room if empty
          if (room.users.length === 0) {
            rooms.delete(socket.roomId);
            console.log(`Room ${socket.roomId} deleted (empty)`);
          }
        }
      }
    }
  }
});

// Error handling với enhanced logging
io.engine.on("connection_error", (err) => {
  console.log("❌ Connection error details:");
  console.log("Request:", err.req?.url);
  console.log("Error code:", err.code);
  console.log("Error message:", err.message);
  console.log("Error context:", err.context);
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    totalUsers: Array.from(rooms.values()).reduce(
      (sum, room) => sum + room.users.length,
      0
    ),
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Access the app at http://localhost:${PORT}`);
  console.log(`🏥 Health check at http://localhost:${PORT}/health`);
  console.log(`🔍 Debug info at http://localhost:${PORT}/api/debug/rooms`);
});
