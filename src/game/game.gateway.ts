import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService } from './game.service';

@WebSocketGateway({ cors: true })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private readonly gameService: GameService) {}

  @SubscribeMessage('reset_game')
  handleResetGame(@ConnectedSocket() client: Socket) {
    if (!this.gameService.isAdmin(client.id)) {
      return;
    }
    this.gameService.resetGame();
    this.server.emit('game_reset');
  }

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    const player = this.gameService.removePlayer(client.id);
    if (player) {
      this.server.emit('player_left', { name: player.name });
    }
  }
  @SubscribeMessage('answer_question')
  handleAnswer(
    @MessageBody()
    data: {
      questionId: number;
      answer: string;
      playerName: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    const isCorrect = this.gameService.checkAnswer(
      data.questionId,
      data.answer,
      client.id,
    );

    // Chỉ gửi kết quả answer_result về đúng client trả lời, trả về đúng key 'isCorrect' cho client
    client.emit('answer_result', {
      playerName: data.playerName,
      isCorrect: isCorrect,
    });

    // Gửi bảng xếp hạng cho từng client theo vai trò
    this.server.sockets.sockets.forEach((sock) => {
      sock.emit('leaderboard_update', this.gameService.getLeaderboard());
    });

    // Kiểm tra nếu tất cả đã trả lời thì mới gửi câu tiếp theo
    if (
      this.gameService.getAnswersReceivedCount() ===
      this.gameService.getCurrentPlayerCount()
    ) {
      this.gameService.prepareNextQuestion();
      // Dừng countdown ngay khi tất cả đã trả lời
      this.gameService.stopCountdown();
      const nextQuestion = this.gameService.getNextQuestion();
      if (nextQuestion) {
        this.gameService.startCountdown(this.server, 15); // Đặt lại countdown trước khi gửi câu hỏi mới
        this.server.emit('new_question', nextQuestion);
      } else {
        // Gửi bảng xếp hạng cuối cho từng client
        this.server.sockets.sockets.forEach((sock) => {
          sock.emit('game_over', this.gameService.getLeaderboard());
        });
      }
    }
  }

  @SubscribeMessage('start_game')
  handleStartGame(@ConnectedSocket() client: Socket) {
    if (!this.gameService.isAdmin(client.id)) {
      return;
    }
    this.gameService.startAutoGameLoop();
    // Khi bắt đầu game, gửi countdown cho câu đầu tiên và gửi câu hỏi đầu tiên
    this.gameService.prepareNextQuestion();
    const nextQuestion = this.gameService.getNextQuestion();
    if (nextQuestion) {
      this.gameService.startCountdown(this.server, 15);
      this.server.emit('new_question', nextQuestion);
    }
  }

  @SubscribeMessage('join_game')
  handleJoinGame(
    @MessageBody() data: { name: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.gameService.addPlayer(client.id, data.name);
    this.server.emit('player_joined', { name: data.name });
    if (this.gameService.isAdmin(client.id)) {
      client.emit('admin_granted');
    }
    this.server.emit('lobby_players', this.gameService.getPlayers());
    // Gửi countdown hiện tại cho người mới vào (nếu đang có câu hỏi)
    if (this.gameService.getCountdownValue() > 0) {
      client.emit('countdown', this.gameService.getCountdownValue());
    }
  }
}
