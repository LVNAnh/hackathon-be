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
});

app.use(cors());
app.use(express.json());

// Serve static files if needed
app.use(express.static("public"));

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

  console.log(`Room created: ${roomId}`);
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
      joinedAt: new Date(),
    };

    room.users.push(user);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = user.name;

    console.log(
      `${user.name} (${socket.id}) joined room ${roomId}. Total users: ${room.users.length}`
    );

    // Thông báo cho các user khác về user mới (chỉ những user đã có trước đó sẽ tạo offer)
    socket.to(roomId).emit("user-joined", {
      id: socket.id,
      name: user.name,
    });
  });

  // Leave room explicitly
  socket.on("leave-room", (roomId) => {
    if (socket.roomId === roomId) {
      handleUserLeave(socket);
    }
  });

  // WebRTC signaling - nhận offer và forward đến target
  socket.on("offer", (data) => {
    console.log(`Forwarding offer from ${socket.id} to ${data.target}`);

    // Validate target exists in same room
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
          `Target user ${data.target} not found in room ${socket.roomId}`
        );
      }
    }
  });

  // WebRTC signaling - nhận answer và forward đến target
  socket.on("answer", (data) => {
    console.log(`Forwarding answer from ${socket.id} to ${data.target}`);

    // Validate target exists in same room
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
          `Target user ${data.target} not found in room ${socket.roomId}`
        );
      }
    }
  });

  // WebRTC signaling - nhận ice candidate và forward
  socket.on("ice-candidate", (data) => {
    console.log(`Forwarding ICE candidate from ${socket.id} to ${data.target}`);

    // Validate target exists in same room
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
          `Target user ${data.target} not found in room ${socket.roomId}`
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

// Error handling
io.engine.on("connection_error", (err) => {
  console.log("Connection error:", err.req);
  console.log("Error code:", err.code);
  console.log("Error message:", err.message);
  console.log("Error context:", err.context);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access the app at http://localhost:${PORT}`);
});
