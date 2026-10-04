import { defineStore } from 'pinia'

// 气象观测按班次隔离编辑权限：观测员只能改本班次记录，复核由值班管理员完成。
export const SHIFTS = ['白班 08:00-20:00', '夜班 20:00-08:00'] as const

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: SHIFTS[0] as string,
    scope: '森林防火巡护管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
  },
})
