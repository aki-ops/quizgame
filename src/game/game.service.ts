import { Injectable } from '@nestjs/common';
import { questions } from '../data/questions';
import { Player } from '../types/game.types';
import { Server } from 'socket.io';

@Injectable()
export class GameService {
  private players = new Map<string, Player>(); // dùng Map thay vì Array
  private currentQuestionIndex = 0;
  private interval: NodeJS.Timeout | null = null;
  private adminId: string | null = null;
  private answersReceived = new Set<string>();
  private countdown: NodeJS.Timeout | null = null;
  private countdownValue = 0;

  addPlayer(id: string, name: string) {
    this.players.set(id, { id, name, score: 0 });
    // Nếu là người đầu tiên join thì set làm admin
    if (this.players.size === 1) {
      this.adminId = id;
    }
  }

  isAdmin(id: string): boolean {
    return this.adminId === id;
  }

  getAdminId(): string | null {
    return this.adminId;
  }

  removePlayer(id: string): { name: string } | null {
    const player = this.players.get(id);
    if (player) {
      this.players.delete(id);
      // Nếu admin rời phòng, chuyển quyền cho người tiếp theo (nếu có)
      if (this.adminId === id) {
        const next: string | undefined = Array.from(this.players.keys())[0];
        this.adminId = next || null;
      }
      return { name: player.name };
    }
    return null;
  }

  startAutoGameLoop() {
    this.currentQuestionIndex = 0;
    this.clearAnswersReceived();
    this.stopCountdown();
    // Reset điểm cho tất cả người chơi khi bắt đầu game mới
    for (const player of this.players.values()) {
      player.score = 0;
    }
    // Đã loại bỏ auto next question
  }

  getPlayers(): Player[] {
    return Array.from(this.players.values());
  }

  getCurrentPlayerCount(): number {
    // Không tính admin vào số lượng người chơi cần trả lời
    return Array.from(this.players.keys()).filter((id) => id !== this.adminId)
      .length;
  }

  getCurrentQuestionId(): number | null {
    if (this.currentQuestionIndex === 0) return null;
    return questions[this.currentQuestionIndex - 1]?.id ?? null;
  }

  getCurrentQuestionPlayerCount(): number {
    return this.players.size;
  }

  getAnswersReceivedCount(): number {
    return this.answersReceived.size;
  }

  getAnswersReceived(): Set<string> {
    return this.answersReceived;
  }

  clearAnswersReceived() {
    this.answersReceived.clear();
  }

  getNextQuestion() {
    // Không reset answersReceived và countdown ở đây nữa
    if (this.currentQuestionIndex < questions.length) {
      const question = questions[this.currentQuestionIndex];
      this.currentQuestionIndex++;
      const { answer, ...safeQuestion } = question;
      void answer;
      return safeQuestion;
    }
    return null;
  }

  prepareNextQuestion() {
    this.clearAnswersReceived();
    this.stopCountdown();
  }

  checkAnswer(questionId: number, answer: string, clientId: string): boolean {
    // Nếu là admin thì không cho trả lời
    if (this.adminId === clientId) {
      return false;
    }
    if (this.answersReceived.has(clientId)) {
      return false; // Không cho trả lời nhiều lần
    }
    this.answersReceived.add(clientId);
    const question = questions.find((q) => q.id === questionId);
    const isCorrect = question?.answer === answer;
    if (isCorrect) {
      const player = this.players.get(clientId);
      if (player) {
        // Tính điểm dựa trên tốc độ trả lời
        // 1000 điểm cho người trả lời đúng đầu tiên, các vị trí sau giảm đều
        const playerIds = Array.from(this.players.keys());
        const adminId = this.adminId;
        const totalPlayers = playerIds.filter((id) => id !== adminId).length;
        const answerOrder = this.answersReceived.size; // thứ tự trả lời đúng (bắt đầu từ 1)
        const minScore = 200; // điểm tối thiểu cho người trả lời cuối cùng
        let score = 1000;
        if (totalPlayers > 1) {
          score = Math.round(
            1000 - ((answerOrder - 1) * (1000 - minScore)) / (totalPlayers - 1),
          );
        }
        if (score < minScore) score = minScore;
        player.score += score;
        this.players.set(clientId, player);
      }
    }
    return isCorrect;
  }

  // Trả về danh sách xếp hạng cho tất cả (admin và player)
  getLeaderboard(): Player[] {
    return Array.from(this.players.values())
      .filter((player) => player.id !== this.adminId)
      .sort((a, b) => b.score - a.score);
  }

  stopCountdown() {
    if (this.countdown) {
      clearInterval(this.countdown);
      this.countdown = null;
    }
    this.countdownValue = 0;
  }

  // Thêm lại các hàm bị thiếu cho gateway
  resetGame() {
    this.currentQuestionIndex = 0;
    this.clearAnswersReceived();
    this.stopCountdown();
    // Reset điểm cho tất cả người chơi
    for (const player of this.players.values()) {
      player.score = 0;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Không xóa players và adminId để giữ lại danh sách người chơi và quyền admin sau khi reset
  }

  startCountdown(server: Server, seconds: number) {
    if (this.countdown) clearInterval(this.countdown); // Dừng countdown cũ trước khi bắt đầu mới
    this.countdownValue = seconds;
    server.emit('countdown', this.countdownValue);
    this.countdown = setInterval(() => {
      this.countdownValue--;
      server.emit('countdown', this.countdownValue);
      if (this.countdownValue <= 0) {
        clearInterval(this.countdown!);
        this.countdown = null;
        // Khi countdown kết thúc, nếu còn câu hỏi thì sang câu mới, nếu hết thì kết thúc game
        const sendGameOverToAll = () => {
          // server.sockets.sockets là Map<string, Socket>
          const socketsMap = server.sockets.sockets as Map<
            string,
            { emit: (event: string, ...args: any[]) => void; id: string }
          >;
          if (typeof socketsMap.forEach === 'function') {
            socketsMap.forEach((sock) => {
              sock.emit('game_over', this.getLeaderboard());
            });
          }
        };
        if (this.currentQuestionIndex < questions.length) {
          this.prepareNextQuestion();
          const nextQuestion = this.getNextQuestion();
          if (nextQuestion) {
            this.startCountdown(server, seconds);
            server.emit('new_question', nextQuestion);
          } else {
            sendGameOverToAll();
          }
        } else {
          sendGameOverToAll();
        }
      }
    }, 1000);
  }

  getCountdownValue() {
    return this.countdownValue;
  }
}
