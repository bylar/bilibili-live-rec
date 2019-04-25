const BigBuffer = require("../lib/BigBuffer.js")
const ScriptTag = require("./ScriptTag.js")
const VideoTag = require("./VideoTag.js")
const AudioTag = require("./AudioTag.js")
const Logger = new (require("./Logger.js"))('FLVprocessor')

class FLVprocessor {
  constructor(args) {
    switch (typeof args) {
      case 'string':
        this.input = args
        break
      case 'object':
        let { input, output, callback, noFix } = args
        this.input = input
        this.output = output
        this.callback = callback
        this.noFix = noFix
        break
    }
    this.buffer = new BigBuffer(this.input)
    this._offset = 0
    this.flvHeader = {}
    this.scriptTags = []
    this.videoTags = []
    this.audioTags = []
    this.tags = []
    this.output = this.output?this.output:`${this.input}.fix.flv`
    this.readFile()
  }
  readFile() {
    this.buffer.readcb = () => {
      this.updateInfo()
      if(!this.noFix){
        this.buffer.saveFile(this.output,()=>{
          if(typeof this.callback === 'function'){
            this.callback()
          }
        })
      }
    }
    this.buffer.readFile()
  }
  updateInfo(){
    this._offset = 0
    this.flvHeader = {}
    this.scriptTags = []
    this.videoTags = []
    this.audioTags = []
    this.tags = []
    this.getFlvHeader()
    this.getTags()
    this.fixTimestamp()
    this.fixDuration()
  }
  getFlvHeader() {
    this.flvHeader['Signature'] = {
      value: this.buffer.slice(this._offset, this._offset + 3).toString(),
      offset: this._offset,
      origin: this.buffer.slice(this._offset, this._offset + 3)
    }
    this._offset += 3
    this.flvHeader['Version'] = {
      value: this.buffer.readUIntBE(this._offset, 1),
      offset: this._offset,
      origin: this.buffer.slice(this._offset, this._offset + 1)
    }
    this._offset += 1
    this.flvHeader['Flags'] = {
      value: FLVprocessor.binaryFill(this.buffer.readUIntBE(this._offset, 1).toString(2), 8),
      offset: this._offset,
      origin: this.buffer.slice(this._offset, this._offset + 1)
    }
    this._offset += 1
    this.flvHeader['Headersize'] = {
      value: this.buffer.readUIntBE(this._offset, 4).toString(10),
      offset: this._offset,
      origin: this.buffer.slice(this._offset, this._offset + 4)
    }
    this._offset += 4
  }
  getTags(){
    let previousTag = null
    while(true){
      let nextType = this.getNextTagType()
      if(nextType === 'unknow')return
      let tag
      if(nextType === 'audio'){
        tag = new AudioTag(this.buffer,this._offset)
        if(tag.isBad) return
        this.audioTags.push(tag)
      } else if(nextType === 'video'){
        tag = new VideoTag(this.buffer,this._offset)
        if(tag.isBad) return
        this.videoTags.push(tag)
      } else if(nextType === 'script'){
        tag = new ScriptTag(this.buffer,this._offset)
        if(tag.isBad) return
        this.scriptTags.push(tag)
      } else if(nextType === 'unknow'){
        if(tag.isBad) return
      }
      this._offset += tag.length
      tag.previousTag = previousTag
      this.tags.push(tag)
      previousTag = tag
    }
  }
  getNextTagType(){
    if(this._offset + 5 > this.buffer.length) return 'unknow'
    let type = Number(this.buffer.readUIntBE(this._offset + 4, 1).toString(10))
    switch(type){
      case 8:
        return 'audio';
      case 9:
        return 'video';
      case 18:
        return 'script';
      default:
        return 'unknow'
    }
  }
  fixTimestamp(){
    this.fixVideoTimestamp()
    this.fixAudioTimestamp()
  }
  fixVideoTimestamp(){
    let firstTag  //第一个tag的时间戳一定是0
    let baseTimestamp = 0
    let previousTimestamp = 0
    let onece = true
    for(let videoTag of this.videoTags){
      if(!firstTag){
        firstTag = videoTag
        continue
      }
      let newTimestamp = videoTag.getTimestamp() - baseTimestamp
      if(newTimestamp<0){
        newTimestamp = videoTag.getTimestamp()
      }
      if(onece && newTimestamp>100){
        //仅在第二个帧是非顺序时间戳的时候进入
        onece = false
        newTimestamp = this.videoTags[this.videoTags.indexOf(videoTag) + 1].getTimestamp() - videoTag.getTimestamp()
      }
      baseTimestamp = videoTag.getTimestamp()
      videoTag.setTimestamp(previousTimestamp + newTimestamp)
      previousTimestamp = videoTag.getTimestamp()
    }
  }
  fixAudioTimestamp(){
    let firstTag  //第一个tag的时间戳一定是0
    let baseTimestamp = 0
    let previousTimestamp = 0
    let onece = true
    for(let audioTag of this.audioTags){
      if(!firstTag){
        firstTag = audioTag
        continue
      }
      let newTimestamp = audioTag.getTimestamp() - baseTimestamp
      if(newTimestamp<0){
        newTimestamp = audioTag.getTimestamp()
      }
      if(onece && newTimestamp>100){
        //仅在第二个帧是非顺序时间戳的时候进入
        onece = false
        newTimestamp = this.audioTags[this.audioTags.indexOf(audioTag) + 1].getTimestamp() - audioTag.getTimestamp()
      }
      baseTimestamp = audioTag.getTimestamp()
      audioTag.setTimestamp(previousTimestamp + newTimestamp)
      previousTimestamp = audioTag.getTimestamp()
    }
  }
  fixDuration(){
    let framerate = this.scriptTags[0].getFramerate()
    if(!framerate){
      //根据前两个非0视频帧时间戳估计
      let first = this.videoTags[1].getTimestamp()
      let second = this.videoTags[2].getTimestamp()
      framerate = 30
    }
    let DurationFromCurrentMaxTimestamp = this.videoTags[this.videoTags.length - 1].getTimestamp()/1000
    let Duration = Math.max(DurationFromCurrentMaxTimestamp,this.videoTags.length/framerate)
    let { needUpdate } = this.scriptTags[0].setDuration(Duration)
    Logger.notice(`帧率: ${framerate}/s`)
    Logger.notice(`总帧数: ${this.videoTags.length}`)
    Logger.notice(`视频长度: ${Duration}`)
    // Logger.debug(`最大修复时间戳: ${this.videoTags[this.videoTags.length - 1].getTimestamp()}`)
    // if(needUpdate){
    //   this.updateInfo()
    // }
  }
  static binaryFill(str, sum) {//补全二进制缺的位数
    let newstr = str
    for (let i = 0; i < sum - str.length; i++) {
      newstr = '0' + newstr
    }
    return newstr
  }
}

module.exports = FLVprocessor