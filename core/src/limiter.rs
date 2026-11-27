//! 全局多线程共享令牌桶限速器。
//!
//! 限速为 0 KB/s 时直接原子快路径返回，零锁竞争、零性能损耗。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::Instant;

struct BucketState {
    burst: f64,
    tokens: f64,
    last: Instant,
}

/// 跨并发分片共享的下载限速器。
pub struct RateLimiter {
    bytes_per_sec: AtomicU64,
    state: Mutex<BucketState>,
}

impl RateLimiter {
    /// 创建限速器实例（`kbps = 0` 表示不限速）。
    pub fn new(kbps: u32) -> Self {
        let rl = Self {
            bytes_per_sec: AtomicU64::new(0),
            state: Mutex::new(BucketState {
                burst: 0.0,
                tokens: 0.0,
                last: Instant::now(),
            }),
        };
        rl.set_rate_kbps_blocking(kbps);
        rl
    }

    /// 同步更新限速阈值。
    pub fn set_rate_kbps_blocking(&self, kbps: u32) {
        let bps = (kbps as u64) * 1024;
        self.bytes_per_sec.store(bps, Ordering::Relaxed);
        if let Ok(mut st) = self.state.try_lock() {
            Self::reset_state(&mut st, bps);
        }
    }

    /// 异步更新限速阈值。
    pub async fn set_rate_kbps(&self, kbps: u32) {
        let bps = (kbps as u64) * 1024;
        self.bytes_per_sec.store(bps, Ordering::Relaxed);
        let mut st = self.state.lock().await;
        Self::reset_state(&mut st, bps);
    }

    fn reset_state(st: &mut BucketState, bps: u64) {
        if bps == 0 {
            st.burst = 0.0;
            st.tokens = 0.0;
            return;
        }
        let f = bps as f64;
        st.burst = f.max(64.0 * 1024.0);
        if st.tokens <= 0.0 || st.tokens > st.burst {
            st.tokens = st.burst;
        }
        st.last = Instant::now();
    }

    /// 申请消费 `n` 字节额度；若当前令牌不足则异步让出协程等待。
    pub async fn wait_n(&self, n: usize) {
        if n == 0 {
            return;
        }
        loop {
            let bps = self.bytes_per_sec.load(Ordering::Relaxed);
            if bps == 0 {
                return;
            }
            let wait_dur = {
                let mut st = self.state.lock().await;
                let bps_now = self.bytes_per_sec.load(Ordering::Relaxed);
                if bps_now == 0 {
                    return;
                }
                let f = bps_now as f64;
                if st.burst < 64.0 * 1024.0 {
                    Self::reset_state(&mut st, bps_now);
                }
                let now = Instant::now();
                let elapsed = now.duration_since(st.last).as_secs_f64();
                if elapsed > 0.0 {
                    st.tokens = (st.tokens + elapsed * f).min(st.burst);
                    st.last = now;
                }
                let need = (n as f64).min(st.burst);
                if st.tokens >= need {
                    st.tokens -= need;
                    return;
                }
                let wait_secs = (need - st.tokens) / f;
                Duration::from_secs_f64(wait_secs.max(0.005))
            };
            tokio::time::sleep(wait_dur).await;
        }
    }
}
